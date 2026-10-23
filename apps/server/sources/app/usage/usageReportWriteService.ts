import { isDeepStrictEqual } from "node:util";

import { usageReportWritesCounter } from "@/app/monitoring/metrics2";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { AsyncLock } from "@/utils/runtime/lock";

type UsageReportWriteSummary = Readonly<{
    id: string;
    createdAt: Date;
    updatedAt: Date;
}>;

export type RecordUsageReportResult =
    | Readonly<{
        ok: true;
        report: UsageReportWriteSummary;
        usageData: PrismaJson.UsageReportData;
        changed: boolean;
    }>
    | Readonly<{ ok: false; error: "session-not-found" }>;

type AccountUsageWriteLockState = {
    readonly lock: AsyncLock;
    refs: number;
};

const accountUsageWriteLocks = new Map<string, AccountUsageWriteLockState>();

async function inAccountUsageWriteLock<T>(
    params: Readonly<{ userId: string; key: string }>,
    run: () => Promise<T>,
): Promise<T> {
    const lockKey = `${params.userId}\0${params.key}`;
    let state = accountUsageWriteLocks.get(lockKey);
    if (!state) {
        state = { lock: new AsyncLock(), refs: 0 };
        accountUsageWriteLocks.set(lockKey, state);
    }
    state.refs += 1;
    try {
        return await state.lock.inLock(run);
    } finally {
        state.refs -= 1;
        if (state.refs === 0 && accountUsageWriteLocks.get(lockKey) === state) {
            accountUsageWriteLocks.delete(lockKey);
        }
    }
}

export async function recordUsageReportForAccount(params: Readonly<{
    userId: string;
    key: string;
    sessionId?: string | null;
    tokens: PrismaJson.UsageReportData["tokens"];
    cost: PrismaJson.UsageReportData["cost"];
}>): Promise<RecordUsageReportResult> {
    const sessionId = params.sessionId ?? null;
    const usageData: PrismaJson.UsageReportData = {
        tokens: params.tokens,
        cost: params.cost,
    };
    const write = async (): Promise<RecordUsageReportResult> => {
        // Fast path: a report that would change nothing is answered from committed rows without
        // opening a write transaction. Only the transaction's own "unchanged" outcome is taken here;
        // every other outcome (not found, new, changed, duplicate rows) runs the transaction below,
        // which re-reads everything. See readUsageReportState for why this is linearizable.
        // The fast path is strictly optional: if its read fails for any reason, the transaction below
        // runs as before. It re-runs this same decision through the transaction client, so an error
        // the transactional path would surface surfaces there again, and a transient one gets
        // inTx's bounded retry, exactly as before the fast path existed.
        const fast = await readUsageReportState(db, { userId: params.userId, sessionId, key: params.key, usageData })
            .catch(() => null);
        if (fast?.kind === "unchanged") {
            usageReportWritesCounter.inc({ scope: fast.scope, result: "unchanged" });
            return { ok: true, report: fast.report, usageData, changed: false };
        }

        return await inTx(async (tx) => {
            const state = await readUsageReportState(tx, { userId: params.userId, sessionId, key: params.key, usageData });
            switch (state.kind) {
                case "session-not-found":
                    usageReportWritesCounter.inc({ scope: "session", result: "session_not_found" });
                    return { ok: false as const, error: "session-not-found" };
                case "unchanged":
                    usageReportWritesCounter.inc({ scope: state.scope, result: "unchanged" });
                    return { ok: true as const, report: state.report, usageData, changed: false };
                case "write-session": {
                    const report = await writeSessionUsageReport(tx, {
                        userId: params.userId,
                        sessionId: state.sessionId,
                        key: params.key,
                        usageData,
                        existed: state.existed,
                    });
                    return { ok: true as const, report, usageData, changed: true };
                }
                case "write-account": {
                    const report = await writeAccountLevelUsageReport(tx, {
                        userId: params.userId,
                        key: params.key,
                        usageData,
                        existing: state.existing,
                        duplicateIds: state.duplicateIds,
                    });
                    return { ok: true as const, report, usageData, changed: true };
                }
            }
        });
    };
    return sessionId
        ? await write()
        : await inAccountUsageWriteLock({ userId: params.userId, key: params.key }, write);
}

type UsageReportReader = Pick<Tx, "session" | "usageReport">;

const USAGE_REPORT_STATE_SELECT = {
    id: true,
    createdAt: true,
    updatedAt: true,
    data: true,
} as const;

type ExistingUsageReport = Readonly<{
    id: string;
    createdAt: Date;
    updatedAt: Date;
    data: unknown;
}>;

type UsageReportState =
    | Readonly<{ kind: "session-not-found" }>
    | Readonly<{ kind: "unchanged"; scope: "session" | "account"; report: UsageReportWriteSummary }>
    | Readonly<{ kind: "write-session"; sessionId: string; existed: boolean }>
    | Readonly<{ kind: "write-account"; existing: ExistingUsageReport | null; duplicateIds: readonly string[] }>;

function toUsageReportWriteSummary(row: ExistingUsageReport): UsageReportWriteSummary {
    return { id: row.id, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

/**
 * The read-only part of a usage report write: what the write would do, decided from `reader`.
 *
 * Inside the transaction `reader` is the transaction client. The fast path calls it with the plain
 * client and acts only on "unchanged". That answer is linearizable at the usage-report read: a
 * session-scoped row naming the session proves the session existed at that instant
 * (UsageReport.sessionId is ON DELETE SET NULL, and foreign keys are enforced), and a session's
 * accountId never changes, so the ownership check read just before holds at that instant too.
 * The account-level read is a single statement.
 */
async function readUsageReportState(
    reader: UsageReportReader,
    params: Readonly<{ userId: string; sessionId: string | null; key: string; usageData: PrismaJson.UsageReportData }>,
): Promise<UsageReportState> {
    if (params.sessionId) {
        const session = await reader.session.findFirst({
            where: { id: params.sessionId, accountId: params.userId },
            select: { id: true },
        });
        if (!session) return { kind: "session-not-found" };
        const existing = await reader.usageReport.findUnique({
            where: {
                accountId_sessionId_key: {
                    accountId: params.userId,
                    sessionId: params.sessionId,
                    key: params.key,
                },
            },
            select: USAGE_REPORT_STATE_SELECT,
        });
        if (existing && isDeepStrictEqual(existing.data, params.usageData)) {
            return { kind: "unchanged", scope: "session", report: toUsageReportWriteSummary(existing) };
        }
        return { kind: "write-session", sessionId: params.sessionId, existed: existing !== null };
    }

    const existingReports = await reader.usageReport.findMany({
        where: {
            accountId: params.userId,
            sessionId: null,
            key: params.key,
        },
        orderBy: [
            { updatedAt: "desc" },
            { createdAt: "desc" },
            { id: "desc" },
        ],
        select: USAGE_REPORT_STATE_SELECT,
    });
    const [existing, ...duplicates] = existingReports;
    if (existing && duplicates.length === 0 && isDeepStrictEqual(existing.data, params.usageData)) {
        return { kind: "unchanged", scope: "account", report: toUsageReportWriteSummary(existing) };
    }
    return {
        kind: "write-account",
        existing: existing ?? null,
        duplicateIds: duplicates.map((report) => report.id),
    };
}

async function writeSessionUsageReport(
    tx: Tx,
    params: Readonly<{
        userId: string;
        sessionId: string;
        key: string;
        usageData: PrismaJson.UsageReportData;
        existed: boolean;
    }>,
): Promise<UsageReportWriteSummary> {
    const report = await tx.usageReport.upsert({
        where: {
            accountId_sessionId_key: {
                accountId: params.userId,
                sessionId: params.sessionId,
                key: params.key,
            },
        },
        update: {
            data: params.usageData,
            updatedAt: new Date(),
        },
        create: {
            accountId: params.userId,
            sessionId: params.sessionId,
            key: params.key,
            data: params.usageData,
        },
        select: {
            id: true,
            createdAt: true,
            updatedAt: true,
        },
    });

    usageReportWritesCounter.inc({ scope: "session", result: params.existed ? "updated" : "created" });
    return report;
}

async function writeAccountLevelUsageReport(
    tx: Tx,
    params: Readonly<{
        userId: string;
        key: string;
        usageData: PrismaJson.UsageReportData;
        existing: ExistingUsageReport | null;
        duplicateIds: readonly string[];
    }>,
): Promise<UsageReportWriteSummary> {
    const existing = params.existing;
    if (existing) {
        if (params.duplicateIds.length > 0) {
            await tx.usageReport.deleteMany({
                where: {
                    accountId: params.userId,
                    sessionId: null,
                    key: params.key,
                    id: { in: [...params.duplicateIds] },
                },
            });
        }

        if (isDeepStrictEqual(existing.data, params.usageData)) {
            // Unchanged data with duplicates removed: readUsageReportState answers "unchanged" only
            // when there were no duplicates, so this branch always deleted at least one row.
            usageReportWritesCounter.inc({ scope: "account", result: "updated" });
            return toUsageReportWriteSummary(existing);
        }

        const report = await tx.usageReport.update({
            where: { id: existing.id },
            data: {
                data: params.usageData,
                updatedAt: new Date(),
            },
            select: {
                id: true,
                createdAt: true,
                updatedAt: true,
            },
        });
        usageReportWritesCounter.inc({ scope: "account", result: "updated" });
        return report;
    }

    const report = await tx.usageReport.create({
        data: {
            accountId: params.userId,
            sessionId: null,
            key: params.key,
            data: params.usageData,
        },
        select: {
            id: true,
            createdAt: true,
            updatedAt: true,
        },
    });
    usageReportWritesCounter.inc({ scope: "account", result: "created" });
    return report;
}
