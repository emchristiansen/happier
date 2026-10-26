import { db } from "@/storage/db";
import { parseIntEnv } from "@/config/env";
import { delay } from "@/utils/runtime/delay";
import { forever } from "@/utils/runtime/forever";
import { shutdownSignal } from "@/utils/process/shutdown";
import { buildMachineActivityEphemeral, eventRouter } from "@/app/events/eventRouter";
import { isRetryableSqliteWriteError } from "@/storage/sqliteRetryClassifier";
import { warn } from "@/utils/logging/log";
import { expireSessionPublisherCandidates } from "./sessionPublisherPresenceTimeout";
import { publishSessionPublisherLifecycleUpdate } from "@/app/session/runtimeActivity/publishPublisherLifecycleUpdate";
import { emitPendingActivationWake } from "./pendingActivationWake";
import { RELEASED_ALIVE_PERSISTENCE_INTERVAL_MS } from "@/app/session/runtimeActivity/releasedAliveTiming";

export interface PresenceTimeoutConfig {
    sessionTimeoutMs: number;
    machineTimeoutMs: number;
    tickMs: number;
}

const DEFAULT_PRESENCE_SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PRESENCE_MACHINE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PRESENCE_TIMEOUT_TICK_MS = 60 * 1000;

export function resolvePresenceTimeoutConfig(env: NodeJS.ProcessEnv = process.env): PresenceTimeoutConfig {
    const sessionTimeoutMs = parseIntEnv(env.HAPPIER_PRESENCE_SESSION_TIMEOUT_MS, DEFAULT_PRESENCE_SESSION_TIMEOUT_MS, { min: 1 });
    // Released heartbeats can leave a live publisher's committed fence unchanged for this interval.
    if (sessionTimeoutMs <= RELEASED_ALIVE_PERSISTENCE_INTERVAL_MS) {
        throw new Error(
            `HAPPIER_PRESENCE_SESSION_TIMEOUT_MS (${sessionTimeoutMs} ms) must be greater than the released heartbeat persistence interval (${RELEASED_ALIVE_PERSISTENCE_INTERVAL_MS} ms)`,
        );
    }
    return {
        sessionTimeoutMs,
        machineTimeoutMs: parseIntEnv(env.HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS, DEFAULT_PRESENCE_MACHINE_TIMEOUT_MS, { min: 1 }),
        tickMs: parseIntEnv(env.HAPPIER_PRESENCE_TIMEOUT_TICK_MS, DEFAULT_PRESENCE_TIMEOUT_TICK_MS, { min: 1 }),
    };
}

type TimedOutMachineCandidate = {
    id: string;
    accountId: string;
    lastActiveAt: Date;
};

type MachineUpdateManyAndReturnDelegate = {
    updateManyAndReturn?: (args: {
        where: {
            id: { in: string[] };
            active: true;
            lastActiveAt: { lte: Date };
        };
        data: { active: false };
        select: { id: true; accountId: true; lastActiveAt: true };
    }) => Promise<TimedOutMachineCandidate[]>;
    updateMany: (args: {
        where: {
            id: { in: string[] };
            active: true;
            lastActiveAt: { lte: Date };
        };
        data: { active: false };
    }) => Promise<{ count: number }>;
};

async function markTimedOutMachinesInactive(
    delegate: MachineUpdateManyAndReturnDelegate,
    candidates: TimedOutMachineCandidate[],
    timedOutAt: Date,
): Promise<TimedOutMachineCandidate[]> {
    if (candidates.length === 0) return [];

    const ids = candidates.map((candidate) => candidate.id);
    const where = { id: { in: ids }, active: true, lastActiveAt: { lte: timedOutAt } } as const;
    const data = { active: false } as const;

    if (delegate.updateManyAndReturn) {
        return await delegate.updateManyAndReturn({
            where,
            data,
            select: { id: true, accountId: true, lastActiveAt: true },
        });
    }

    const { count } = await delegate.updateMany({ where, data });
    if (count === candidates.length) return candidates;
    // Without RETURNING support, exact changed IDs are unknowable after a race. Emit only when
    // every candidate was updated; otherwise stay conservative and let the next tick observe remaining active rows.
    return [];
}

export async function runPresenceTimeoutTick(timeoutConfig: PresenceTimeoutConfig): Promise<void> {
    try {
        const timedOutBefore = Date.now() - timeoutConfig.sessionTimeoutMs;
        const sessions = await db.session.findMany({
            where: {
                active: true,
                lastActiveAt: {
                    lte: new Date(timedOutBefore)
                }
            },
            select: { id: true, lastActiveAt: true },
        });
        const expired = await expireSessionPublisherCandidates({
            candidates: sessions.map((session) => ({
                sessionId: session.id,
                observedFence: session.lastActiveAt,
            })),
            observedBefore: new Date(timedOutBefore),
        });
        for (const result of expired) {
            if (result.status !== 'expired') continue;
            await publishSessionPublisherLifecycleUpdate({
                sessionId: result.sessionId,
                participantCursors: result.participantCursors,
                active: false,
                activeAt: result.activeAt.getTime(),
            });
            if (result.activationHint) {
                await emitPendingActivationWake({
                    sessionId: result.sessionId,
                    participantCursors: result.participantCursors,
                    wake: result.activationHint,
                });
            }
        }
    } catch (error) {
        if (!isRetryableSqliteWriteError(error)) throw error;
        warn({ module: "presence-timeout", error }, "Transient DB error while timing out sessions");
        return;
    }

    try {
        const timedOutBefore = Date.now() - timeoutConfig.machineTimeoutMs;
        const machines = await db.machine.findMany({
            where: {
                active: true,
                lastActiveAt: {
                    lte: new Date(timedOutBefore)
                }
            },
            select: { id: true, accountId: true, lastActiveAt: true },
        });
        const changedMachines = await markTimedOutMachinesInactive(db.machine, machines, new Date(timedOutBefore));
        for (const machine of changedMachines) {
            eventRouter.emitEphemeral({
                userId: machine.accountId,
                payload: buildMachineActivityEphemeral(machine.id, false, machine.lastActiveAt.getTime()),
                recipientFilter: { type: 'user-scoped-only' }
            });
        }
    } catch (error) {
        if (!isRetryableSqliteWriteError(error)) throw error;
        warn({ module: "presence-timeout", error }, "Transient DB error while timing out machines");
    }
}

export function startTimeout() {
    const timeoutConfig = resolvePresenceTimeoutConfig(process.env);
    forever('session-timeout', async () => {
        while (true) {
            await runPresenceTimeoutTick(timeoutConfig);
            await delay(timeoutConfig.tickMs, shutdownSignal);
        }
    });
}
