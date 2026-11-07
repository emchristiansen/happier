import type {
    PrimaryTurnStatusV1,
    SessionRuntimeActivityProjection,
    SessionRuntimeIssueV1,
} from "@happier-dev/protocol";

import { refreshSessionParticipantBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import {
    buildUpdateSessionUpdate,
    type ClientConnection,
    eventRouter,
} from "@/app/events/eventRouter";
import type { SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";

/** The single post-commit fanout owner for publisher reachability and Runtime Activity. */
export async function publishSessionPublisherLifecycleUpdate(params: Readonly<{
    sessionId: string;
    participantCursors: readonly SessionParticipantCursor[];
    active?: boolean;
    activeAt?: number;
    projection?: SessionRuntimeActivityProjection;
    latestTurnId?: string | null;
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    latestTurnStatusObservedAt?: number | null;
    lastRuntimeIssue?: SessionRuntimeIssueV1 | null;
    badgeAttentionChanged?: boolean;
    skipSenderAccountId?: string;
    skipSenderConnection?: ClientConnection;
}>): Promise<void> {
    await Promise.all(params.participantCursors.map(async ({ accountId, cursor }) => {
        eventRouter.emitUpdate({
            userId: accountId,
            payload: buildUpdateSessionUpdate(
                params.sessionId,
                cursor,
                randomKeyNaked(12),
                undefined,
                undefined,
                {
                    ...(typeof params.active === "boolean" ? { active: params.active } : {}),
                    ...(typeof params.activeAt === "number" ? { activeAt: params.activeAt } : {}),
                    ...(params.projection ? {
                        runtimeActivityState: params.projection.state,
                        runtimeActivityRevision: params.projection.revision,
                        runtimeActivityActiveCount: params.projection.activeCount,
                        runtimeActivityObservedAt: params.projection.observedAt,
                    } : {}),
                    ...("latestTurnId" in params ? { latestTurnId: params.latestTurnId } : {}),
                    ...("latestTurnStatus" in params ? { latestTurnStatus: params.latestTurnStatus } : {}),
                    ...("latestTurnStatusObservedAt" in params
                        ? { latestTurnStatusObservedAt: params.latestTurnStatusObservedAt }
                        : {}),
                    ...("lastRuntimeIssue" in params ? { lastRuntimeIssue: params.lastRuntimeIssue } : {}),
                },
            ),
            recipientFilter: { type: "all-interested-in-session", sessionId: params.sessionId },
            ...(params.skipSenderConnection && accountId === params.skipSenderAccountId
                ? { skipSenderConnection: params.skipSenderConnection }
                : {}),
        });
    }));
    // Reachability changes badge eligibility independently of turn or Runtime Activity updates.
    if (params.badgeAttentionChanged === true || typeof params.active === "boolean") {
        await refreshSessionParticipantBadgePushes({
            badgeAttentionChanged: true,
            participantCursors: params.participantCursors,
        });
    }
}
