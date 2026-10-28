import type { Prisma } from "@prisma/client";
import type { Tx } from "@/storage/inTx";

const SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT = 50;

export function createSessionRollbackEligibleTurnsSelect(
    params: Readonly<{ limit?: number }> = {},
): Prisma.Session$turnsArgs {
    return {
        where: { rollbackState: "eligible" },
        orderBy: [
            { updatedAt: "desc" },
            { createdAt: "desc" },
            { id: "desc" },
        ],
        take: params.limit ?? SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT,
        select: {
            transcriptAnchorsJson: true,
            rollbackState: true,
        },
    };
}

export function readSessionTurnRollbackEligibleStarts(row: object): number[] {
    const candidateTurns = (row as { turns?: unknown }).turns;
    const turns = Array.isArray(candidateTurns)
        ? candidateTurns as readonly Readonly<{ transcriptAnchorsJson?: string | null; rollbackState?: string | null }>[]
        : [];
    const starts = new Set<number>();
    for (const turn of turns) {
        if (turn.rollbackState !== "eligible") continue;
        if (typeof turn.transcriptAnchorsJson !== "string" || turn.transcriptAnchorsJson.trim().length === 0) continue;
        try {
            const parsed = JSON.parse(turn.transcriptAnchorsJson) as { startUserMessageSeq?: unknown };
            const startUserMessageSeq = parsed.startUserMessageSeq;
            if (
                typeof startUserMessageSeq !== "number"
                || !Number.isFinite(startUserMessageSeq)
                || startUserMessageSeq < 0
            ) continue;
            starts.add(Math.trunc(startUserMessageSeq));
        } catch {
            continue;
        }
    }
    return [...starts].sort((a, b) => a - b);
}

export async function loadSessionRollbackEligibleTurnStartsInTx(
    tx: Tx,
    sessionId: string,
): Promise<number[]> {
    const relation = createSessionRollbackEligibleTurnsSelect();
    const turns = await tx.sessionTurn.findMany({
        ...relation,
        where: { ...relation.where, sessionId },
    });
    return readSessionTurnRollbackEligibleStarts({ turns });
}
