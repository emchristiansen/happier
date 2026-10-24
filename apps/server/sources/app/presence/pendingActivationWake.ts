import type { SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { mapPendingActivationAuthorization } from "@/app/session/pending/pendingActivationAuthorization";
import { emitPendingActivationHint } from "@/app/session/pending/publishPendingMutation";
import type { Tx } from "@/storage/inTx";

/**
 * A session's waiting activation request, read in the transaction that made the session inactive.
 * Its owner's machines are woken for it again, so a daemon whose earlier activation attempt failed
 * starts the runtime; once the session is inactive, the presence timeout no longer selects it.
 */
export type PendingActivationWake = Readonly<{
    accountId: string;
    requestId: string;
    pendingCount: number;
    pendingBlockedCount: number;
    pendingVersion: number;
}>;

/** The exact waiting request still current for the session's fence, if any. */
export async function readPendingActivationWakeInTx(params: Readonly<{
    tx: Tx;
    sessionId: string;
}>): Promise<PendingActivationWake | undefined> {
    const session = await params.tx.session.findUniqueOrThrow({
        where: { id: params.sessionId },
        select: {
            accountId: true,
            lastActiveAt: true,
            pendingCount: true,
            pendingBlockedCount: true,
            pendingVersion: true,
            pendingActivationRequestId: true,
            pendingActivationRequestedAt: true,
            pendingActivationStatus: true,
            pendingActivationFailureCode: true,
        },
    });
    const authorization = mapPendingActivationAuthorization(session);
    if (authorization?.status !== "waiting") return undefined;
    return {
        accountId: session.accountId,
        requestId: authorization.requestId,
        pendingCount: session.pendingCount,
        pendingBlockedCount: session.pendingBlockedCount,
        pendingVersion: session.pendingVersion,
    };
}

/** Sends the lossy machine-scoped activation hint for a wake; durable authorization stays authoritative. */
export async function emitPendingActivationWake(params: Readonly<{
    sessionId: string;
    participantCursors: readonly SessionParticipantCursor[];
    wake: PendingActivationWake;
}>): Promise<void> {
    await emitPendingActivationHint({
        sessionId: params.sessionId,
        changedByAccountId: params.wake.accountId,
        pendingCount: params.wake.pendingCount,
        pendingBlockedCount: params.wake.pendingBlockedCount,
        pendingVersion: params.wake.pendingVersion,
        participantCursors: [...params.participantCursors],
        activationTarget: {
            accountId: params.wake.accountId,
            requestId: params.wake.requestId,
        },
    });
}
