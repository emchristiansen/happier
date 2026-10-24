import type { SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { markSessionParticipantsChanged } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { inTx } from "@/storage/inTx";
import { readPendingActivationWakeInTx, type PendingActivationWake } from "./pendingActivationWake";

export type TimeoutPublisherResult =
    | { status: "expired"; sessionId: string; activeAt: Date; participantCursors: readonly SessionParticipantCursor[]; activationHint?: PendingActivationWake }
    | { status: "stale"; sessionId: string };

/** Expires only exact scanned reachability fences; Runtime Activity is deliberately not imported. */
export async function expireSessionPublisherCandidates(params: Readonly<{
    candidates: readonly Readonly<{ sessionId: string; observedFence: Date }>[];
    observedBefore: Date;
}>): Promise<TimeoutPublisherResult[]> {
    const results: TimeoutPublisherResult[] = [];
    for (const candidate of params.candidates) {
        results.push(await inTx(async (tx): Promise<TimeoutPublisherResult> => {
            const updated = await tx.session.updateMany({
                where: {
                    id: candidate.sessionId,
                    active: true,
                    archivedAt: null,
                    lastActiveAt: candidate.observedFence,
                    AND: { lastActiveAt: { lte: params.observedBefore } },
                },
                data: { active: false },
            });
            if (updated.count === 0) return { status: "stale", sessionId: candidate.sessionId };
            const participantCursors = await markSessionParticipantsChanged({ tx, sessionId: candidate.sessionId });
            const activationHint = await readPendingActivationWakeInTx({ tx, sessionId: candidate.sessionId });
            return {
                status: "expired",
                sessionId: candidate.sessionId,
                activeAt: candidate.observedFence,
                participantCursors,
                ...(activationHint ? { activationHint } : {}),
            };
        }));
    }
    return results;
}
