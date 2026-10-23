import { isDeepStrictEqual } from "node:util";
import { Buffer } from "node:buffer";
import { z } from "zod";

import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { resolveEncryptionWriteRejectionCode, type EncryptionPolicyRejectionCode } from "@/app/session/encryptionRejectionCodes";
import { checkSessionAccess, requireAccessLevel } from "@/app/share/accessControl";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";
import {
    isStoredContentKindAllowedForSessionByStoragePolicy,
    SessionSystemRecordKindSchema,
    SessionSystemRecordLatestQuerySchema,
    SessionSystemRecordListQuerySchema,
    SessionSystemRecordLookupQuerySchema,
    SessionSystemRecordNamespaceSchema,
    SessionSystemRecordUpsertRequestSchema,
    SessionStoredMessageContentSchema,
    type SessionStoredContentKind,
} from "@happier-dev/protocol";

const SESSION_SYSTEM_RECORD_CURSOR_PREFIX = "v1";
const SESSION_SYSTEM_RECORD_MAX_LIMIT = 500;
const SESSION_SYSTEM_RECORD_DEFAULT_LIMIT = 100;

export type SessionSystemRecordNamespace = z.infer<typeof SessionSystemRecordNamespaceSchema>;
export type SessionSystemRecordKind = z.infer<typeof SessionSystemRecordKindSchema>;
type SessionStoredMessageContent = z.infer<typeof SessionStoredMessageContentSchema>;
type SessionRecordAccountScope = Readonly<{ accountId: string }>;

export type SessionSystemRecordRow = Readonly<{
    id: string;
    sessionId: string;
    namespace: SessionSystemRecordNamespace;
    kind: SessionSystemRecordKind;
    localId: string;
    content: SessionStoredMessageContent;
    createdAt: Date;
    updatedAt: Date;
}>;

export type UpsertSessionSystemRecordParams = Readonly<{
    actorUserId: string;
    sessionId: string;
    namespace: SessionSystemRecordNamespace;
    kind: SessionSystemRecordKind;
    localId: string;
    content: SessionStoredMessageContent;
}>;

export type ListSessionSystemRecordsParams = Readonly<{
    actorUserId: string;
    sessionId: string;
    namespace?: SessionSystemRecordNamespace;
    kind?: SessionSystemRecordKind;
    localId?: string;
    limit?: number;
    cursor?: string;
}>;

export type GetSessionSystemRecordParams = Readonly<{
    actorUserId: string;
    sessionId: string;
    namespace: SessionSystemRecordNamespace;
    localId: string;
}>;

export type GetLatestSessionSystemRecordParams = Readonly<{
    actorUserId: string;
    sessionId: string;
    namespace: SessionSystemRecordNamespace;
    kind: SessionSystemRecordKind;
}>;

export type UpsertSessionSystemRecordResult =
    | { ok: true; didCreate: boolean; didUpdate: boolean; record: SessionSystemRecordRow }
    | { ok: false; error: "invalid-params" | "forbidden" | "session-not-found" | "conflict" | "internal"; code?: EncryptionPolicyRejectionCode };

export type ListSessionSystemRecordsResult =
    | { ok: true; records: SessionSystemRecordRow[]; nextCursor: string | null }
    | { ok: false; error: "invalid-params" | "forbidden" | "session-not-found" | "internal" };

export type GetSessionSystemRecordResult =
    | { ok: true; record: SessionSystemRecordRow | null }
    | { ok: false; error: "invalid-params" | "forbidden" | "session-not-found" | "internal" };

export type GetLatestSessionSystemRecordResult =
    | { ok: true; record: SessionSystemRecordRow | null }
    | { ok: false; error: "invalid-params" | "forbidden" | "session-not-found" | "internal" };

const SESSION_SYSTEM_RECORD_SELECT = {
    id: true,
    accountId: true,
    sessionId: true,
    namespace: true,
    kind: true,
    localId: true,
    content: true,
    createdAt: true,
    updatedAt: true,
} as const;

function parseRecordPayload(value: unknown): {
    namespace: SessionSystemRecordNamespace;
    kind: SessionSystemRecordKind;
    localId: string;
    content: SessionStoredMessageContent;
} | null {
    const parsed = SessionSystemRecordUpsertRequestSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function toSessionSystemRecordRow(row: {
    id: string;
    sessionId: string;
    namespace: unknown;
    kind: unknown;
    localId: string;
    content: unknown;
    createdAt: Date;
    updatedAt: Date;
}): SessionSystemRecordRow | null {
    const parsed = parseRecordPayload({
        namespace: row.namespace,
        kind: row.kind,
        localId: row.localId,
        content: row.content,
    });
    if (!parsed) return null;
    return {
        id: row.id,
        sessionId: row.sessionId,
        namespace: parsed.namespace,
        kind: parsed.kind,
        localId: parsed.localId,
        content: parsed.content,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

function normalizeLimit(limit: number | undefined): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) return SESSION_SYSTEM_RECORD_DEFAULT_LIMIT;
    return Math.min(SESSION_SYSTEM_RECORD_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function encodeCursor(row: Pick<SessionSystemRecordRow, "updatedAt" | "id">): string {
    return Buffer.from(`${SESSION_SYSTEM_RECORD_CURSOR_PREFIX}:${row.updatedAt.getTime()}:${row.id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): { updatedAt: Date; id: string } | null {
    if (!cursor) return null;
    try {
        const decoded = Buffer.from(cursor, "base64url").toString("utf8");
        const [version, updatedAtMsRaw, id] = decoded.split(":");
        const updatedAtMs = Number(updatedAtMsRaw);
        if (version !== SESSION_SYSTEM_RECORD_CURSOR_PREFIX || !Number.isFinite(updatedAtMs) || !id) return null;
        return { updatedAt: new Date(updatedAtMs), id };
    } catch {
        return null;
    }
}

async function ensureSessionRecordAccess(params: Readonly<{ actorUserId: string; sessionId: string }>): Promise<
    | { ok: true }
    | { ok: false; error: "invalid-params" | "session-not-found" | "forbidden" }
> {
    if (!params.actorUserId || !params.sessionId) {
        return { ok: false, error: "invalid-params" };
    }
    const access = await checkSessionAccess(params.actorUserId, params.sessionId);
    if (!access) {
        return { ok: false, error: "session-not-found" };
    }
    return { ok: true };
}

async function ensureSessionRecordWriteAccess(params: Readonly<{ actorUserId: string; sessionId: string }>): Promise<
    | { ok: true }
    | { ok: false; error: "invalid-params" | "session-not-found" | "forbidden" }
> {
    if (!params.actorUserId || !params.sessionId) {
        return { ok: false, error: "invalid-params" };
    }
    const access = await checkSessionAccess(params.actorUserId, params.sessionId);
    if (!access) {
        return { ok: false, error: "session-not-found" };
    }
    if (!requireAccessLevel(access, "edit")) {
        return { ok: false, error: "forbidden" };
    }
    return { ok: true };
}

function validateUpsertParams(params: UpsertSessionSystemRecordParams): { ok: true } | { ok: false } {
    if (!params.actorUserId || !params.sessionId) return { ok: false };
    return SessionSystemRecordUpsertRequestSchema.safeParse({
        namespace: params.namespace,
        kind: params.kind,
        localId: params.localId,
        content: params.content,
    }).success ? { ok: true } : { ok: false };
}

function validateListParams(params: ListSessionSystemRecordsParams): { ok: true } | { ok: false } {
    if (!params.actorUserId || !params.sessionId) return { ok: false };
    if (!SessionSystemRecordListQuerySchema.safeParse({
        namespace: params.namespace,
        kind: params.kind,
        localId: params.localId,
        limit: params.limit,
        cursor: params.cursor,
    }).success) return { ok: false };
    if (params.cursor !== undefined && params.cursor !== null && !decodeCursor(params.cursor)) return { ok: false };
    return { ok: true };
}

function validateLookupParams(params: GetSessionSystemRecordParams): { ok: true } | { ok: false } {
    if (!params.actorUserId || !params.sessionId) return { ok: false };
    return SessionSystemRecordLookupQuerySchema.safeParse({
        namespace: params.namespace,
        localId: params.localId,
    }).success ? { ok: true } : { ok: false };
}

function validateLatestParams(params: GetLatestSessionSystemRecordParams): { ok: true } | { ok: false } {
    if (!params.actorUserId || !params.sessionId) return { ok: false };
    return SessionSystemRecordLatestQuerySchema.safeParse({
        namespace: params.namespace,
        kind: params.kind,
    }).success ? { ok: true } : { ok: false };
}

function buildStorageModeRejection(params: Readonly<{
    storagePolicy: ReturnType<typeof readEncryptionFeatureEnv>["storagePolicy"];
    sessionEncryptionMode: "e2ee" | "plain";
    content: SessionStoredMessageContent;
}>): { ok: true } | { ok: false; code: EncryptionPolicyRejectionCode } {
    const writeKind: SessionStoredContentKind = params.content.t === "plain" ? "plain" : "encrypted";
    if (isStoredContentKindAllowedForSessionByStoragePolicy(params.storagePolicy, params.sessionEncryptionMode, writeKind)) {
        return { ok: true };
    }
    return {
        ok: false,
        code: resolveEncryptionWriteRejectionCode({
            storagePolicy: params.storagePolicy,
            sessionEncryptionMode: params.sessionEncryptionMode,
            writeKind,
        }),
    };
}

function resolveSystemRecordAccountScope(params: Readonly<{
    namespace: SessionSystemRecordNamespace;
    actorUserId: string;
    sessionAccountId: string | undefined;
}>): SessionRecordAccountScope {
    // Memory records are actor-private. Workflow activity records are session-scoped durable
    // projections referenced by session metadata, so every authorized participant must read the same
    // owner-owned row rather than an actor-local empty namespace.
    return {
        accountId: params.namespace === "activity"
            ? (params.sessionAccountId ?? params.actorUserId)
            : params.actorUserId,
    };
}

export async function upsertSessionSystemRecord(
    params: UpsertSessionSystemRecordParams,
): Promise<UpsertSessionSystemRecordResult> {
    return upsertSessionSystemRecordWithRetry(params, true);
}

async function upsertSessionSystemRecordWithRetry(
    params: UpsertSessionSystemRecordParams,
    retryUniqueRace: boolean,
): Promise<UpsertSessionSystemRecordResult> {
    if (!validateUpsertParams(params).ok) {
        return { ok: false, error: "invalid-params" };
    }

    const access = await ensureSessionRecordWriteAccess(params);
    if (!access.ok) return access;

    try {
        // Fast path: an upsert that would change nothing is answered from committed rows without
        // opening a write transaction. Only the transaction's own "unchanged" outcome is taken here;
        // every other outcome runs the transaction below, which re-reads everything. See
        // readSessionSystemRecordUpsertState for why this is linearizable.
        // The fast path is strictly optional: if its read fails for any reason, the transaction below
        // runs as before. It re-runs this same decision through the transaction client, so an error
        // the transactional path would surface surfaces there again, and a transient one gets
        // inTx's bounded retry, exactly as before the fast path existed.
        const fast = await readSessionSystemRecordUpsertState(db, params).catch(() => null);
        if (fast?.kind === "unchanged") return fast.result;

        return await inTx(async (tx) => {
            const state = await readSessionSystemRecordUpsertState(tx, params);
            switch (state.kind) {
                case "unchanged":
                case "rejected":
                    return state.result;
                case "update": {
                    const updated = await tx.sessionSystemRecord.update({
                        where: { id: state.existingId },
                        data: { content: params.content },
                        select: SESSION_SYSTEM_RECORD_SELECT,
                    });
                    const updatedRecord = toSessionSystemRecordRow(updated);
                    if (!updatedRecord) return { ok: false, error: "internal" };
                    return { ok: true, didCreate: false, didUpdate: true, record: updatedRecord };
                }
                case "create": {
                    const created = await tx.sessionSystemRecord.create({
                        data: {
                            ...state.recordScope,
                            sessionId: params.sessionId,
                            namespace: params.namespace,
                            kind: params.kind,
                            localId: params.localId,
                            content: params.content,
                        },
                        select: SESSION_SYSTEM_RECORD_SELECT,
                    });
                    const createdRecord = toSessionSystemRecordRow(created);
                    if (!createdRecord) return { ok: false, error: "internal" };
                    return { ok: true, didCreate: true, didUpdate: false, record: createdRecord };
                }
            }
        });
    } catch (error) {
        if (retryUniqueRace && isPrismaErrorCode(error, "P2002")) {
            return await upsertSessionSystemRecordWithRetry(params, false);
        }
        return { ok: false, error: "internal" };
    }
}

type SessionSystemRecordReader = Pick<Tx, "session" | "sessionSystemRecord">;

type SessionSystemRecordUpsertState =
    | Readonly<{ kind: "unchanged"; result: Extract<UpsertSessionSystemRecordResult, { ok: true }> }>
    | Readonly<{ kind: "rejected"; result: Extract<UpsertSessionSystemRecordResult, { ok: false }> }>
    | Readonly<{ kind: "update"; existingId: string }>
    | Readonly<{ kind: "create"; recordScope: SessionRecordAccountScope }>;

/**
 * The read-only part of an upsert: what it would do, decided from `reader`.
 *
 * Inside the transaction `reader` is the transaction client. The fast path calls it with the plain
 * client and acts only on "unchanged". That answer is linearizable at the record read: a record
 * naming the session proves the session existed at that instant (SessionSystemRecord.sessionId is
 * ON DELETE CASCADE, and foreign keys are enforced), and the session fields read just before
 * (accountId, which fixes the record scope, and encryptionMode, which the storage policy checks)
 * never change after the session is created.
 */
async function readSessionSystemRecordUpsertState(
    reader: SessionSystemRecordReader,
    params: UpsertSessionSystemRecordParams,
): Promise<SessionSystemRecordUpsertState> {
    const session = await reader.session.findUnique({
        where: { id: params.sessionId },
        select: { accountId: true, encryptionMode: true },
    });
    if (!session) return { kind: "rejected", result: { ok: false, error: "session-not-found" } };
    const recordScope = resolveSystemRecordAccountScope({
        namespace: params.namespace,
        actorUserId: params.actorUserId,
        sessionAccountId: typeof session.accountId === "string" ? session.accountId : undefined,
    });

    const sessionEncryptionMode: "e2ee" | "plain" = session.encryptionMode === "plain" ? "plain" : "e2ee";
    const storageMode = buildStorageModeRejection({
        storagePolicy: readEncryptionFeatureEnv(process.env).storagePolicy,
        sessionEncryptionMode,
        content: params.content,
    });
    if (!storageMode.ok) {
        return { kind: "rejected", result: { ok: false, error: "invalid-params", code: storageMode.code } };
    }

    const existing = await reader.sessionSystemRecord.findUnique({
        where: {
            accountId_sessionId_namespace_localId: {
                accountId: recordScope.accountId,
                sessionId: params.sessionId,
                namespace: params.namespace,
                localId: params.localId,
            },
        },
        select: SESSION_SYSTEM_RECORD_SELECT,
    });
    if (!existing) return { kind: "create", recordScope };

    if (existing.kind !== params.kind) {
        return { kind: "rejected", result: { ok: false, error: "conflict" } };
    }
    const existingRecord = toSessionSystemRecordRow(existing);
    if (!existingRecord) return { kind: "rejected", result: { ok: false, error: "internal" } };
    if (isDeepStrictEqual(existingRecord.content, params.content)) {
        return { kind: "unchanged", result: { ok: true, didCreate: false, didUpdate: false, record: existingRecord } };
    }
    return { kind: "update", existingId: existing.id };
}

export async function listSessionSystemRecords(
    params: ListSessionSystemRecordsParams,
): Promise<ListSessionSystemRecordsResult> {
    if (!validateListParams(params).ok) {
        return { ok: false, error: "invalid-params" };
    }

    const access = await ensureSessionRecordAccess(params);
    if (!access.ok) return access;

    const limit = normalizeLimit(params.limit);
    const cursor = decodeCursor(params.cursor);

    try {
        return await inTx(async (tx) => {
            const session = await tx.session.findUnique({
                where: { id: params.sessionId },
                select: { accountId: true, encryptionMode: true },
            });
            if (!session) return { ok: false, error: "session-not-found" };
            const recordScope = resolveSystemRecordAccountScope({
                namespace: params.namespace ?? "memory",
                actorUserId: params.actorUserId,
                sessionAccountId: typeof session.accountId === "string" ? session.accountId : undefined,
            });

            const rows = await tx.sessionSystemRecord.findMany({
                where: {
                    accountId: recordScope.accountId,
                    sessionId: params.sessionId,
                    ...(params.namespace ? { namespace: params.namespace } : {}),
                    ...(params.kind ? { kind: params.kind } : {}),
                    ...(params.localId ? { localId: params.localId } : {}),
                    ...(cursor
                        ? {
                            OR: [
                                { updatedAt: { lt: cursor.updatedAt } },
                                { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
                            ],
                        }
                        : {}),
                },
                orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
                take: limit + 1,
                select: SESSION_SYSTEM_RECORD_SELECT,
            });
            const pageRows = rows.slice(0, limit);
            const records = pageRows.map(toSessionSystemRecordRow);
            if (records.some((record) => record === null)) return { ok: false, error: "internal" };
            const last = pageRows.at(-1);
            return {
                ok: true,
                records: records as SessionSystemRecordRow[],
                nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
            };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export async function getSessionSystemRecord(
    params: GetSessionSystemRecordParams,
): Promise<GetSessionSystemRecordResult> {
    if (!validateLookupParams(params).ok) {
        return { ok: false, error: "invalid-params" };
    }

    const access = await ensureSessionRecordAccess(params);
    if (!access.ok) return access;

    try {
        return await inTx(async (tx) => {
            const session = await tx.session.findUnique({
                where: { id: params.sessionId },
                select: { accountId: true, encryptionMode: true },
            });
            if (!session) return { ok: false, error: "session-not-found" };
            const recordScope = resolveSystemRecordAccountScope({
                namespace: params.namespace,
                actorUserId: params.actorUserId,
                sessionAccountId: typeof session.accountId === "string" ? session.accountId : undefined,
            });

            const row = await tx.sessionSystemRecord.findUnique({
                where: {
                    accountId_sessionId_namespace_localId: {
                        accountId: recordScope.accountId,
                        sessionId: params.sessionId,
                        namespace: params.namespace,
                        localId: params.localId,
                    },
                },
                select: SESSION_SYSTEM_RECORD_SELECT,
            });
            if (!row) return { ok: true, record: null };
            const record = toSessionSystemRecordRow(row);
            if (!record) return { ok: false, error: "internal" };
            return { ok: true, record };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export async function getLatestSessionSystemRecord(
    params: GetLatestSessionSystemRecordParams,
): Promise<GetLatestSessionSystemRecordResult> {
    if (!validateLatestParams(params).ok) {
        return { ok: false, error: "invalid-params" };
    }

    const access = await ensureSessionRecordAccess(params);
    if (!access.ok) return access;

    try {
        return await inTx(async (tx) => {
            const session = await tx.session.findUnique({
                where: { id: params.sessionId },
                select: { accountId: true, encryptionMode: true },
            });
            if (!session) return { ok: false, error: "session-not-found" };
            const recordScope = resolveSystemRecordAccountScope({
                namespace: params.namespace,
                actorUserId: params.actorUserId,
                sessionAccountId: typeof session.accountId === "string" ? session.accountId : undefined,
            });

            const row = await tx.sessionSystemRecord.findFirst({
                where: {
                    accountId: recordScope.accountId,
                    sessionId: params.sessionId,
                    namespace: params.namespace,
                    kind: params.kind,
                },
                orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
                select: SESSION_SYSTEM_RECORD_SELECT,
            });
            if (!row) return { ok: true, record: null };
            const record = toSessionSystemRecordRow(row);
            if (!record) return { ok: false, error: "internal" };
            return { ok: true, record };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}
