import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { sessionRoutes } from "./sessionRoutes";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    // Test-boundary bridge: route helpers use the app-local Fastify alias with auth decorations.
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    sessionRoutes(typed);
    return trackApp(typed);
}

type ObservedRead = Readonly<{ model: string; args: unknown }>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/** True when a Prisma select tree asks for the `turns` relation of a `Session`, at any depth. */
function selectsSessionTurns(node: unknown): boolean {
    if (Array.isArray(node)) return node.some(selectsSessionTurns);
    if (!isRecord(node)) return false;
    if (isRecord(node.select) && "turns" in node.select) return true;
    return Object.values(node).some(selectsSessionTurns);
}

/**
 * Rollback eligibility is a per-session projection of that session's eligible `SessionTurn` rows.
 * Selecting it as a relation on a multi-session list read makes Prisma fetch *every* eligible turn of
 * every listed session in one `sessionId IN (…)` statement (`LIMIT -1`, sorted in a temp B-tree) and
 * keep its per-session `take` in memory: on a 4,876-session account that was ~32k rows for one
 * 200-row archived page, 2.6 s cold against 0.14 s without the relation, and 7–22 s for a full
 * archive walk. The cost grows with each session's whole turn history, not with what is used.
 *
 * Clients keep eligibility current from the detailed turns projection they fetch with the session
 * and on every turn update, and from the starts carried by turn-mutation events; a list row only
 * ever offered a fallback. So list reads must not select the relation and their rows must not claim
 * a value (`rollbackEligibleTurnStarts` is optional on the wire), while the single-session read keeps
 * serving it, bounded to one session.
 */
describe("session rollback eligibility on list and single-session reads (SQLite integration)", () => {
    let harness: LightSqliteHarness;
    const restoreObservers: Array<() => void> = [];

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-list-rollback-eligibility-sqlite-",
            initAuth: true,
            initEncrypt: false,
            initFiles: false,
        });
    }, 180_000);

    afterEach(async () => {
        for (const restore of restoreObservers.splice(0)) restore();
        await closeTrackedApps();
        harness.resetEnv();
        await db.sessionTurn.deleteMany();
        await db.sessionShare.deleteMany();
        await db.accessKey.deleteMany();
        await db.session.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => await harness.close());

    function observeReads(): ObservedRead[] {
        const reads: ObservedRead[] = [];
        const delegates = { session: db.session, sessionShare: db.sessionShare } as Record<string, unknown>;
        for (const [model, delegate] of Object.entries(delegates)) {
            for (const method of ["findMany", "findFirst", "findUnique"] as const) {
                // Prisma's proxy methods need explicit binding; keep every real query intact.
                const target = delegate as Record<string, (args: unknown) => Promise<unknown>>;
                const original = target[method].bind(target);
                target[method] = async (args) => {
                    reads.push({ model, args });
                    return await original(args);
                };
                restoreObservers.push(() => { target[method] = original; });
            }
        }
        return reads;
    }

    async function createAccount(): Promise<string> {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        return account.id;
    }

    async function createSessionWithEligibleTurns(params: Readonly<{
        accountId: string;
        id: string;
        active?: boolean;
        archivedAt?: number;
        startUserMessageSeqs: readonly number[];
    }>): Promise<void> {
        const now = Date.now();
        await db.session.create({
            data: {
                id: params.id,
                accountId: params.accountId,
                tag: `tag-${params.id}`,
                metadata: "{}",
                meaningfulActivityAt: new Date(now),
                createdAt: new Date(now),
                active: params.active ?? false,
                lastActiveAt: new Date(now),
                archivedAt: params.archivedAt === undefined ? null : new Date(params.archivedAt),
            },
        });
        for (const [index, seq] of params.startUserMessageSeqs.entries()) {
            await db.sessionTurn.create({
                data: {
                    sessionId: params.id,
                    turnId: `${params.id}-turn-${index}`,
                    status: "completed",
                    startedAt: BigInt(now + index),
                    updatedAt: BigInt(now + index),
                    transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: seq }),
                    rollbackState: "eligible",
                },
            });
        }
    }

    async function getJson(userId: string, url: string): Promise<Record<string, unknown>> {
        const app = createTestApp();
        const token = await auth.createToken(userId);
        const response = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
        expect(response.statusCode, response.body).toBe(200);
        return response.json() as Record<string, unknown>;
    }

    function rowsById(body: Record<string, unknown>, key: string): Map<string, Record<string, unknown>> {
        const rows = body[key];
        if (!Array.isArray(rows)) throw new Error(`response carried no ${key} array`);
        return new Map(rows.map((row) => [(row as { id: string }).id, row as Record<string, unknown>]));
    }

    async function seed(): Promise<string> {
        const userId = await createAccount();
        await createSessionWithEligibleTurns({ accountId: userId, id: "live-active", active: true, startUserMessageSeqs: [8, 2] });
        await createSessionWithEligibleTurns({ accountId: userId, id: "live-idle", startUserMessageSeqs: [5] });
        await createSessionWithEligibleTurns({
            accountId: userId,
            id: "archived-row",
            archivedAt: Date.now() - 1_000,
            startUserMessageSeqs: [1, 3],
        });
        return userId;
    }

    it.each([
        ["live page with active and attention families", "/v2/sessions?limit=200&includeActive=true&includeAttention=true", ["live-active", "live-idle"]],
        ["archived page", "/v2/sessions/archived?limit=200", ["archived-row"]],
        ["active family", "/v2/sessions/active", ["live-active"]],
    ])("the %s neither selects the turns relation nor claims rollback starts", async (_label, url, expectedIds) => {
        const userId = await seed();
        const reads = observeReads();

        const body = await getJson(userId, url);

        const rows = rowsById(body, "sessions");
        for (const id of expectedIds) {
            expect(rows.get(id), `row ${id}`).toBeDefined();
            expect(rows.get(id)).not.toHaveProperty("rollbackEligibleTurnStarts");
        }
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.filter((read) => selectsSessionTurns(read.args))).toEqual([]);
    });

    it("the legacy v1 list neither selects the turns relation nor claims rollback starts", async () => {
        const userId = await seed();
        const reads = observeReads();

        const body = await getJson(userId, "/v1/sessions");

        const rows = rowsById(body, "sessions");
        expect([...rows.keys()].sort()).toEqual(["live-active", "live-idle"]);
        for (const row of rows.values()) expect(row).not.toHaveProperty("rollbackEligibleTurnStarts");
        expect(reads.filter((read) => selectsSessionTurns(read.args))).toEqual([]);
    });

    it("the single-session read still serves the session's rollback-eligible turn starts", async () => {
        const userId = await seed();
        const reads = observeReads();

        const active = await getJson(userId, "/v2/sessions/live-active");
        const archived = await getJson(userId, "/v2/sessions/archived-row");

        expect((active.session as Record<string, unknown>).rollbackEligibleTurnStarts).toEqual([2, 8]);
        expect((archived.session as Record<string, unknown>).rollbackEligibleTurnStarts).toEqual([1, 3]);
        expect(reads.filter((read) => selectsSessionTurns(read.args))).toHaveLength(2);
    });
});
