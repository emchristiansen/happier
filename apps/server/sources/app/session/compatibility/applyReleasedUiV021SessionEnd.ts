import { refreshSessionParticipantBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import { didSessionActivityBadgeContributionChange } from "@/app/activity/accountActivityBadge";
import {
    buildSessionActivityEphemeral,
    buildUpdateSessionUpdate,
    eventRouter,
} from "@/app/events/eventRouter";
import { activityCache } from "@/app/presence/sessionCache";
import { markSessionParticipantsChanged } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { writeSessionRuntimeActivityObserverLossInTx } from "@/app/session/runtimeActivity/writeProjection";
import { applyLatestSessionTurnEndInTx } from "@/app/session/sessionWriteService";
import { inTx } from "@/storage/inTx";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import {
    PrimaryTurnStatusV1Schema,
    SessionRuntimeIssueV1Schema,
    type PrimaryTurnStatusV1,
    type SessionRuntimeIssueV1,
} from "@happier-dev/protocol";

function readMillis(value: unknown): number | null {
    if (typeof value === "bigint") {
        const numberValue = Number(value);
        return Number.isSafeInteger(numberValue) && numberValue >= 0 ? numberValue : null;
    }
    if (value instanceof Date) return value.getTime();
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseStoredRuntimeIssue(value: unknown): SessionRuntimeIssueV1 | null {
    if (typeof value !== "string") return null;
    try {
        const parsed = SessionRuntimeIssueV1Schema.safeParse(JSON.parse(value));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

export type ApplyReleasedUiV021SessionEndResult =
    | Readonly<{ status: "applied" | "unchanged" }>
    | Readonly<{ status: "rejected"; reason: "not_found" | "unauthorized" | "archived" | "stale" }>;

/**
 * Compatibility application service for the released user-scoped `session-end`
 * event. It coordinates the current turn and Runtime Activity owners in one
 * transaction; it does not recreate the removed HTTP session-end owner.
 */
export async function applyReleasedUiV021SessionEnd(params: Readonly<{
    accountId: string;
    sessionId: string;
    observedAt: number;
}>): Promise<ApplyReleasedUiV021SessionEndResult> {
    const result = await inTx(async (tx) => {
        const session = await tx.session.findUnique({
            where: { id: params.sessionId },
            select: {
                accountId: true,
                archivedAt: true,
                active: true,
                lastActiveAt: true,
                seq: true,
                pendingCount: true,
                pendingBlockedCount: true,
                lastViewedSessionSeq: true,
                pendingPermissionRequestCount: true,
                pendingUserActionRequestCount: true,
                latestTurnId: true,
                latestTurnStatus: true,
                latestTurnStatusObservedAt: true,
                lastRuntimeIssue: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityObservedAt: true,
                runtimeActivityRevision: true,
            },
        });
        if (!session) return { status: "rejected" as const, reason: "not_found" as const };
        if (session.accountId !== params.accountId) {
            return { status: "rejected" as const, reason: "unauthorized" as const };
        }
        if (session.archivedAt !== null) {
            return { status: "rejected" as const, reason: "archived" as const };
        }

        const latestTurnObservedAt = readMillis(session.latestTurnStatusObservedAt);
        const newestActivityAt = Math.max(
            session.lastActiveAt.getTime(),
            latestTurnObservedAt ?? 0,
        );
        if (params.observedAt < newestActivityAt) {
            return { status: "rejected" as const, reason: "stale" as const };
        }

        const turn = session.latestTurnId && session.latestTurnStatus === "in_progress"
            ? await applyLatestSessionTurnEndInTx({
                tx,
                sessionId: params.sessionId,
                mutationId: `released-ui-v0.2.1:session-end:${params.sessionId}:${params.observedAt}`,
                observedAt: params.observedAt,
            })
            : null;
        const activity = await writeSessionRuntimeActivityObserverLossInTx({
            tx,
            sessionId: params.sessionId,
        });
        if (activity.status === "rejected") {
            throw new Error(`Released UI Stop could not clear Runtime Activity: ${activity.reason}`);
        }

        if (session.active) {
            await tx.session.update({
                where: { id: params.sessionId },
                data: {
                    active: false,
                    lastActiveAt: new Date(params.observedAt),
                    thinking: false,
                    thinkingAt: new Date(params.observedAt),
                },
            });
        }

        const didApply = session.active || turn?.didApply === true || activity.status === "applied";
        if (!didApply) return { status: "unchanged" as const };

        const participantCursors = await markSessionParticipantsChanged({
            tx,
            sessionId: params.sessionId,
        });
        const currentTurnStatus = PrimaryTurnStatusV1Schema.safeParse(session.latestTurnStatus);
        const latestTurnStatus: PrimaryTurnStatusV1 | null = turn
            ? turn.latestTurnStatus
            : currentTurnStatus.success
                ? currentTurnStatus.data
                : null;
        const latestTurnStatusObservedAt = turn
            ? turn.latestTurnStatusObservedAt
            : latestTurnObservedAt;
        const lastRuntimeIssue = turn
            ? turn.lastRuntimeIssue
            : parseStoredRuntimeIssue(session.lastRuntimeIssue);
        const nextProjection = activity.projection;
        const badgeAttentionChanged = didSessionActivityBadgeContributionChange(session, {
            ...session,
            active: false,
            latestTurnStatus,
            lastRuntimeIssue,
        });
        return {
            status: "applied" as const,
            participantCursors,
            badgeAttentionChanged,
            activeChanged: session.active,
            activeAt: params.observedAt,
            activityChanged: activity.status === "applied",
            activityProjection: nextProjection,
            turnChanged: turn?.didApply === true,
            latestTurnId: turn?.latestTurnId ?? session.latestTurnId,
            latestTurnStatus,
            latestTurnStatusObservedAt,
            lastRuntimeIssue,
        };
    });

    if (result.status !== "applied") return result;
    if (result.activeChanged) {
        activityCache.markSessionInactive(params.sessionId, params.accountId, params.observedAt);
    }
    await Promise.all(result.participantCursors.map(async ({ accountId, cursor }) => {
        eventRouter.emitUpdate({
            userId: accountId,
            payload: buildUpdateSessionUpdate(
                params.sessionId,
                cursor,
                randomKeyNaked(12),
                undefined,
                undefined,
                {
                    ...(result.activeChanged ? { active: false, activeAt: result.activeAt } : {}),
                    ...(result.activityChanged ? {
                        runtimeActivityState: result.activityProjection.state,
                        runtimeActivityActiveCount: result.activityProjection.activeCount,
                        runtimeActivityObservedAt: result.activityProjection.observedAt,
                        runtimeActivityRevision: result.activityProjection.revision,
                    } : {}),
                    ...(result.turnChanged ? {
                        latestTurnId: result.latestTurnId,
                        latestTurnStatus: result.latestTurnStatus,
                        latestTurnStatusObservedAt: result.latestTurnStatusObservedAt,
                        lastRuntimeIssue: result.lastRuntimeIssue,
                    } : {}),
                },
            ),
            recipientFilter: { type: "all-interested-in-session", sessionId: params.sessionId },
        });
    }));
    await refreshSessionParticipantBadgePushes({
        badgeAttentionChanged: result.badgeAttentionChanged,
        participantCursors: result.participantCursors,
    });
    if (result.activeChanged) {
        eventRouter.emitEphemeral({
            userId: params.accountId,
            payload: buildSessionActivityEphemeral(params.sessionId, false, params.observedAt, false),
            recipientFilter: { type: "user-scoped-only" },
        });
    }
    return { status: "applied" };
}
