import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { sessionRoutes } from "./sessionRoutes";

/**
 * The session list answers each visibility arm as two statements: rows with `meaningfulActivityAt`
 * ordered by it, and rows without it ordered by `createdAt` (`findV2SessionListRowsByEffectiveActivity`).
 * For the viewer's own arm no full index served either shape without reading the whole account:
 *
 * - `GET /v2/sessions`, NOT NULL arm: `(accountId, meaningfulActivityAt, id)` walked every session of
 *   the account and rejected the archived ones row by row;
 * - both routes' NULL arm: `(accountId, archivedAt)` read every row of that archive state and sorted
 *   it in a temp b-tree.
 *
 * Migration `20261105150000_session_list_partial_indexes` adds one partial index per shape. These
 * tests drive the real handlers, capture the SQL Prisma actually emits for them (query events), and
 * read each statement's plan from the Prisma query engine's own SQLite — the engine production runs.
 * A separately built SQLite (`node:sqlite`, the sqlite3 CLI) is a different version and can choose a
 * different plan for the same SQL. They also pin that the pages are the same with the indexes as the
 * fixture's own definition says they must be, so the indexes change cost and nothing else.
 *
 * A Prisma-generated `RedefineTables` rebuild of `Session` would silently drop both indexes
 * (`schema.prisma` cannot declare a partial index); the DDL test below is what notices.
 */

const LIVE_INDEX = "Session_accountId_meaningfulActivityAt_id_live_idx";
const NULL_ACTIVITY_INDEX = "Session_accountId_createdAt_id_nullActivity_idx";
const ATTENTION_INDEX = "Session_accountId_needsAttention_meaningfulActivityAt_id_idx";
const PARTIAL_INDEX_DDL = {
    [NULL_ACTIVITY_INDEX]:
        `CREATE INDEX "${NULL_ACTIVITY_INDEX}" ON "Session"("accountId", "createdAt", "id") WHERE "meaningfulActivityAt" IS NULL`,
    [LIVE_INDEX]:
        `CREATE INDEX "${LIVE_INDEX}" ON "Session"("accountId", "meaningfulActivityAt", "id") WHERE "archivedAt" IS NULL`,
} as const;

// Small pages, so every walk crosses several cursors.
const LIVE_PAGE_LIMIT = 3;
const ARCHIVED_PAGE_LIMIT = 4;

const BASE_AT = 1_700_000_000_000;
const STEP_MS = 60_000;

type Owner = "viewer" | "other";

/**
 * One fixture session. `k` is its effective-activity rank: a session with activity has
 * `meaningfulActivityAt = at(k)` and a `createdAt` in the opposite order, so ordering by `createdAt`
 * would be visibly wrong; a session without activity has `createdAt = at(k)`.
 */
type SessionSpec = Readonly<{
    id: string;
    owner: Owner;
    archived: boolean;
    activity: "set" | "null";
    k: number;
    shared?: boolean;
    attention?: boolean;
    active?: boolean;
}>;

const SESSIONS: readonly SessionSpec[] = [
    // Viewer, live. Pages of 3 end on set→set, null→set (across the k=30 tie) and set→null.
    { id: "s-01", owner: "viewer", archived: false, activity: "set", k: 40 },
    { id: "s-02", owner: "viewer", archived: false, activity: "null", k: 38 },
    { id: "s-03", owner: "viewer", archived: false, activity: "set", k: 36, active: true },
    { id: "s-04", owner: "viewer", archived: false, activity: "null", k: 34 },
    { id: "s-05", owner: "viewer", archived: false, activity: "set", k: 30, attention: true },
    { id: "s-06", owner: "viewer", archived: false, activity: "null", k: 30, attention: true },
    { id: "s-07", owner: "viewer", archived: false, activity: "set", k: 26, active: true },
    { id: "s-08", owner: "viewer", archived: false, activity: "null", k: 22, attention: true },
    // Other account, shared with the viewer.
    { id: "s-09", owner: "other", shared: true, archived: false, activity: "set", k: 37 },
    { id: "s-10", owner: "other", shared: true, archived: false, activity: "null", k: 28 },
    { id: "s-30", owner: "other", shared: true, archived: true, activity: "set", k: 36 },
    { id: "s-31", owner: "other", shared: true, archived: true, activity: "null", k: 24 },
    // Viewer, archived. Pages of 4 end on set→set, null→set and set→null; a k=17 tie inside a page.
    { id: "s-14", owner: "viewer", archived: true, activity: "set", k: 39 },
    { id: "s-15", owner: "viewer", archived: true, activity: "null", k: 38 },
    { id: "s-16", owner: "viewer", archived: true, activity: "null", k: 37 },
    { id: "s-17", owner: "viewer", archived: true, activity: "set", k: 35 },
    { id: "s-18", owner: "viewer", archived: true, activity: "set", k: 33 },
    { id: "s-19", owner: "viewer", archived: true, activity: "null", k: 31 },
    { id: "s-20", owner: "viewer", archived: true, activity: "null", k: 29 },
    { id: "s-21", owner: "viewer", archived: true, activity: "set", k: 27 },
    { id: "s-22", owner: "viewer", archived: true, activity: "null", k: 25 },
    { id: "s-23", owner: "viewer", archived: true, activity: "set", k: 23 },
    { id: "s-24", owner: "viewer", archived: true, activity: "null", k: 21 },
    { id: "s-25", owner: "viewer", archived: true, activity: "set", k: 19 },
    { id: "s-26", owner: "viewer", archived: true, activity: "set", k: 17 },
    { id: "s-27", owner: "viewer", archived: true, activity: "null", k: 17 },
    { id: "s-28", owner: "viewer", archived: true, activity: "set", k: 13 },
    { id: "s-29", owner: "viewer", archived: true, activity: "null", k: 11 },
    // Other account, not shared: interleaved with the viewer's ranks, never visible to the viewer.
    { id: "s-11", owner: "other", archived: false, activity: "set", k: 39 },
    { id: "s-12", owner: "other", archived: false, activity: "null", k: 35 },
    { id: "s-13", owner: "other", archived: true, activity: "set", k: 34 },
    { id: "s-32", owner: "other", archived: true, activity: "null", k: 32 },
    { id: "s-33", owner: "other", archived: false, activity: "set", k: 31 },
    { id: "s-34", owner: "other", archived: false, activity: "null", k: 29, attention: true },
    { id: "s-35", owner: "other", archived: true, activity: "set", k: 27 },
    { id: "s-36", owner: "other", archived: true, activity: "null", k: 20 },
    { id: "s-37", owner: "other", archived: false, activity: "set", k: 15 },
    { id: "s-38", owner: "other", archived: false, activity: "null", k: 12 },
    { id: "s-39", owner: "other", archived: true, activity: "set", k: 10 },
    { id: "s-40", owner: "other", archived: true, activity: "null", k: 9 },
];

const at = (k: number) => BASE_AT + k * STEP_MS;

function isVisibleTo(spec: SessionSpec, viewer: Owner): boolean {
    return spec.owner === viewer || (viewer === "viewer" && spec.shared === true);
}

/** The list order by definition: effective activity desc, then id desc. Independent of any index. */
function expectedListIds(viewer: Owner, archived: boolean): string[] {
    return SESSIONS
        .filter((spec) => spec.archived === archived && isVisibleTo(spec, viewer))
        .sort((a, b) => (b.k - a.k) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
        .map((spec) => spec.id);
}

const specById = new Map(SESSIONS.map((spec) => [spec.id, spec]));

type ObservedQuery = Readonly<{ query: string; params: string }>;

type ObservingClient = Readonly<{
    session: { findMany: (args: unknown) => Promise<unknown> };
    $on: (event: "query", callback: (event: ObservedQuery) => void) => void;
    $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T>;
    $disconnect: () => Promise<void>;
}>;

type StatementKind =
    | "list.notNull"
    | "list.null"
    | "attention.notNull"
    | "attention.null"
    | "active"
    | "other";

type PlannedStatement = Readonly<{
    kind: StatementKind;
    /** `owner` binds `accountId = ?`; `shared` binds the viewer's shared ids by primary key. */
    arm: "owner" | "shared" | "neither";
    query: string;
    plan: string[];
}>;

type ListPage = Readonly<{
    body: { sessions: Array<{ id: string; meaningfulActivityAt: number }>; nextCursor: string | null; hasNext: boolean; includedActive?: boolean };
    statements: PlannedStatement[];
}>;

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

function classify(query: string): Pick<PlannedStatement, "kind" | "arm"> {
    const arm = /`main`\.`Session`\.`accountId` = \?/.test(query)
        ? "owner"
        : /`main`\.`Session`\.`id` IN \(/.test(query) ? "shared" : "neither";
    if (/ORDER BY `main`\.`Session`\.`lastActiveAt` DESC/.test(query)) return { kind: "active", arm };
    const family = /`main`\.`Session`\.`needsAttention` = \?/.test(query) ? "attention" : "list";
    if (/`main`\.`Session`\.`meaningfulActivityAt` IS NOT NULL/.test(query)) return { kind: `${family}.notNull`, arm };
    if (/`main`\.`Session`\.`meaningfulActivityAt` IS NULL/.test(query)) return { kind: `${family}.null`, arm };
    return { kind: "other", arm };
}

describe("session list partial indexes (SQLite integration, real handlers)", () => {
    let harness: LightSqliteHarness;
    let observing: ObservingClient;
    let observed: ObservedQuery[] = [];
    let engineVersion = "";
    const accountIds: Record<Owner, string> = { viewer: "", other: "" };
    const tokens: Record<Owner, string> = { viewer: "", other: "" };

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-list-partial-indexes-sqlite-",
            initAuth: true,
            initEncrypt: false,
            initFiles: false,
        });

        // A second client on the same database file, with query events enabled, so the statements
        // the handlers issue can be observed exactly as the engine receives them.
        const { PrismaClient } = await import("../../../../../generated/sqlite-client/index.js");
        observing = new PrismaClient({ log: [{ emit: "event", level: "query" }] }) as unknown as ObservingClient;
        observing.$on("query", (event) => {
            observed.push({ query: event.query, params: event.params });
        });
        [{ version: engineVersion }] = await observing.$queryRawUnsafe<Array<{ version: string }>>(
            "SELECT sqlite_version() AS version",
        );

        for (const owner of ["viewer", "other"] as const) {
            const account = await db.account.create({ data: { publicKey: `pk-${owner}` }, select: { id: true } });
            accountIds[owner] = account.id;
            tokens[owner] = await auth.createToken(account.id);
        }
        const now = new Date();
        for (const spec of SESSIONS) {
            await db.session.create({
                data: {
                    id: spec.id,
                    accountId: accountIds[spec.owner],
                    tag: `tag-${spec.id}`,
                    metadata: "{}",
                    meaningfulActivityAt: spec.activity === "set" ? new Date(at(spec.k)) : null,
                    createdAt: new Date(spec.activity === "set" ? BASE_AT - spec.k * 1_000 : at(spec.k)),
                    archivedAt: spec.archived ? new Date(BASE_AT) : null,
                    pendingPermissionRequestCount: spec.attention ? 1 : 0,
                    active: spec.active ?? false,
                    lastActiveAt: spec.active ? now : new Date(BASE_AT),
                },
            });
            if (spec.shared) {
                await db.sessionShare.create({
                    data: { sessionId: spec.id, sharedByUserId: accountIds.other, sharedWithUserId: accountIds.viewer },
                });
            }
        }
    }, 180_000);

    afterAll(async () => {
        await closeTrackedApps();
        await observing?.$disconnect();
        await harness?.close();
    });

    async function explainThroughEngine(statement: ObservedQuery): Promise<string[]> {
        // EXPLAIN does not execute the statement, and a freshly migrated database has no
        // sqlite_stat tables, so the bound values cannot change the plan; they are rebound as logged.
        const params = JSON.parse(statement.params) as unknown[];
        const rows = await observing.$queryRawUnsafe<Array<{ detail: string }>>(
            `EXPLAIN QUERY PLAN ${statement.query}`,
            ...params,
        );
        return rows.map((row) => row.detail);
    }

    /**
     * Issue one real request with every `Session` list read served by the query-event client — a
     * boundary observation, not a mock: the handler's own arguments run against the same database —
     * and return the response with the plan of each `Session` statement it issued.
     */
    async function getObserved(owner: Owner, url: string): Promise<ListPage> {
        const app = createTestApp();
        const delegate = db.session as unknown as { findMany: (args: unknown) => Promise<unknown> };
        const original = delegate.findMany;
        let findManyCalls = 0;
        delegate.findMany = async (args: unknown) => {
            findManyCalls += 1;
            return await observing.session.findMany(args);
        };
        observed = [];
        let response;
        try {
            response = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${tokens[owner]}` } });
        } finally {
            delegate.findMany = original;
        }
        expect(response.statusCode, response.body).toBe(200);

        // Query events reach JS asynchronously and may land after the query's own promise — and so
        // after the response — has resolved. Each redirected `findMany` emits exactly one top-level
        // `Session` SELECT (its relation loads read other tables), so wait for that exact set rather
        // than trusting the response as a cut-off. Waiting here also guarantees no event of this
        // request is still in flight when the next request resets the window. `^SELECT` keeps out the
        // events of this helper's own `EXPLAIN`s.
        const sessionSelects = () => observed.filter(({ query }) => /^SELECT [\s\S]*\bFROM `main`\.`Session` WHERE/.test(query));
        const selectsAtResponse = sessionSelects().length;
        const deadline = Date.now() + 10_000;
        while (sessionSelects().length < findManyCalls && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        const captured = sessionSelects();
        expect(captured.length, `query events for ${findManyCalls} Session findMany calls of ${url}`).toBe(findManyCalls);

        const statements: PlannedStatement[] = [];
        for (const statement of captured) {
            const plan = await explainThroughEngine(statement);
            statements.push({ ...classify(statement.query), query: statement.query, plan });
        }
        if (process.env.HAPPIER_TEST_PRINT_SESSION_LIST_PLANS === "1") {
            console.log(`[session-list-capture] ${JSON.stringify({ url, findManyCalls, selectsAtResponse, selectsCaptured: captured.length })}`);
            for (const statement of statements) {
                console.log(`[session-list-plan] ${JSON.stringify({ engine: engineVersion, url, ...statement })}`);
            }
        }
        return { body: response.json() as ListPage["body"], statements };
    }

    async function walkPages(owner: Owner, path: string, limit: number): Promise<ListPage[]> {
        const pages: ListPage[] = [];
        let cursor: string | null = null;
        do {
            const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
            const page = await getObserved(owner, `${path}?${query.toString()}`);
            pages.push(page);
            cursor = page.body.nextCursor;
            expect(page.body.hasNext).toBe(cursor !== null);
            expect(pages.length, "page walk did not terminate").toBeLessThan(20);
        } while (cursor);
        return pages;
    }

    function single(statements: PlannedStatement[], kind: StatementKind, arm: PlannedStatement["arm"]): PlannedStatement {
        const matching = statements.filter((statement) => statement.kind === kind && statement.arm === arm);
        expect(matching, `${kind}/${arm} among:\n${statements.map((s) => `${s.kind}/${s.arm}: ${s.query}`).join("\n")}`)
            .toHaveLength(1);
        return matching[0]!;
    }

    function expectWalks(statement: PlannedStatement, index: string, keyTerm: string): void {
        const context = `engine sqlite ${engineVersion}\n${statement.query}\n${statement.plan.join("\n")}`;
        expect(statement.plan.some((detail) => detail.includes(`USING INDEX ${index} (${keyTerm}`)), context).toBe(true);
        expect(statement.plan.filter((detail) => detail.includes("USE TEMP B-TREE")), context).toEqual([]);
    }

    function expectNoNewIndex(statement: PlannedStatement): void {
        const context = `engine sqlite ${engineVersion}\n${statement.query}\n${statement.plan.join("\n")}`;
        expect(statement.plan.filter((detail) => detail.includes(LIVE_INDEX) || detail.includes(NULL_ACTIVITY_INDEX)), context)
            .toEqual([]);
    }

    function expectPagesMatch(pages: ListPage[], expectedIds: string[], limit: number): void {
        const ids = pages.flatMap((page) => page.body.sessions.map((row) => row.id));
        expect(ids).toEqual(expectedIds);
        for (const [index, page] of pages.entries()) {
            expect(page.body.sessions.length).toBe(index < pages.length - 1 ? limit : expectedIds.length - limit * index);
            for (const row of page.body.sessions) {
                expect(row.meaningfulActivityAt, row.id).toBe(at(specById.get(row.id)!.k));
            }
        }
    }

    /** Anti-vacuity: the walk really crossed the NULL/non-NULL boundary at page edges, both ways. */
    function pageEdgeCrossings(pages: ListPage[]): Set<string> {
        const crossings = new Set<string>();
        for (let index = 0; index + 1 < pages.length; index++) {
            const last = pages[index]!.body.sessions.at(-1)!;
            const next = pages[index + 1]!.body.sessions[0]!;
            crossings.add(`${specById.get(last.id)!.activity}->${specById.get(next.id)!.activity}`);
        }
        return crossings;
    }

    it("the migration creates both partial indexes with exactly the reviewed DDL", async () => {
        const rows = await db.$queryRawUnsafe<Array<{ name: string; sql: string }>>(
            `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name IN (?, ?) ORDER BY name`,
            NULL_ACTIVITY_INDEX,
            LIVE_INDEX,
        );
        expect(Object.fromEntries(rows.map((row) => [row.name, row.sql]))).toEqual(PARTIAL_INDEX_DDL);
    });

    it("GET /v2/sessions pages the viewer's live and shared rows in effective-activity order", async () => {
        const pages = await walkPages("viewer", "/v2/sessions", LIVE_PAGE_LIMIT);

        expectPagesMatch(pages, expectedListIds("viewer", false), LIVE_PAGE_LIMIT);
        expect(pageEdgeCrossings(pages)).toEqual(new Set(["set->null", "null->set", "set->set"]));
        expect(pages.flatMap((page) => page.body.sessions.map((row) => row.id))).toEqual(
            expect.arrayContaining(["s-09", "s-10"]),
        );
    });

    it("GET /v2/sessions/archived pages the viewer's archived and shared rows in effective-activity order", async () => {
        const pages = await walkPages("viewer", "/v2/sessions/archived", ARCHIVED_PAGE_LIMIT);

        expectPagesMatch(pages, expectedListIds("viewer", true), ARCHIVED_PAGE_LIMIT);
        expect(pageEdgeCrossings(pages)).toEqual(new Set(["set->null", "null->set", "set->set"]));
        expect(pages.flatMap((page) => page.body.sessions.map((row) => row.id))).toEqual(
            expect.arrayContaining(["s-30", "s-31"]),
        );
    });

    it("another account sees only its own sessions, never the viewer's", async () => {
        const live = await walkPages("other", "/v2/sessions", LIVE_PAGE_LIMIT);
        const archived = await walkPages("other", "/v2/sessions/archived", ARCHIVED_PAGE_LIMIT);

        expectPagesMatch(live, expectedListIds("other", false), LIVE_PAGE_LIMIT);
        expectPagesMatch(archived, expectedListIds("other", true), ARCHIVED_PAGE_LIMIT);
    });

    it("every GET /v2/sessions page walks the live index (NOT NULL arm) and the NULL-activity index (NULL arm)", async () => {
        const pages = await walkPages("viewer", "/v2/sessions", LIVE_PAGE_LIMIT);
        expect(pages.length).toBeGreaterThan(2);

        for (const [index, page] of pages.entries()) {
            const notNull = single(page.statements, "list.notNull", "owner");
            const nullArm = single(page.statements, "list.null", "owner");
            if (index > 0) {
                expect(notNull.query).toMatch(/`main`\.`Session`\.`meaningfulActivityAt` < \?/);
                expect(nullArm.query).toMatch(/`main`\.`Session`\.`createdAt` < \?/);
            }
            expectWalks(notNull, LIVE_INDEX, "accountId=?");
            expectWalks(nullArm, NULL_ACTIVITY_INDEX, "accountId=?)");
            for (const shared of page.statements.filter((statement) => statement.arm === "shared")) expectNoNewIndex(shared);
        }
    });

    it("every GET /v2/sessions/archived page walks the NULL-activity index (NULL arm), the NOT NULL arm unchanged", async () => {
        const pages = await walkPages("viewer", "/v2/sessions/archived", ARCHIVED_PAGE_LIMIT);
        expect(pages.length).toBeGreaterThan(2);

        for (const [index, page] of pages.entries()) {
            const notNull = single(page.statements, "list.notNull", "owner");
            const nullArm = single(page.statements, "list.null", "owner");
            if (index > 0) {
                expect(nullArm.query).toMatch(/`main`\.`Session`\.`createdAt` < \?/);
            }
            expectWalks(nullArm, NULL_ACTIVITY_INDEX, "accountId=?)");
            // `archivedAt IS NOT NULL` does not imply the live index's predicate, so this arm keeps
            // the full `(accountId, meaningfulActivityAt, id)` index it already stopped early on.
            expectWalks(notNull, "Session_accountId_meaningfulActivityAt_id_idx", "accountId=?");
            for (const shared of page.statements.filter((statement) => statement.arm === "shared")) expectNoNewIndex(shared);
        }
    });

    it("the initial page with attention and active families keeps every family read seekable", async () => {
        const page = await getObserved("viewer", `/v2/sessions?limit=${LIVE_PAGE_LIMIT}&includeAttention=1&includeActive=1`);

        // Behaviour: the page, plus the attention rows (s-05, s-06, s-08) and the active row (s-07)
        // that lie beyond it.
        const ids = page.body.sessions.map((row) => row.id);
        expect(ids).toEqual(expect.arrayContaining(["s-01", "s-02", "s-09", "s-05", "s-06", "s-08", "s-07"]));
        expect(ids.filter((id) => !isVisibleTo(specById.get(id)!, "viewer") || specById.get(id)!.archived)).toEqual([]);
        expect(page.body.includedActive).toBe(true);

        expectWalks(single(page.statements, "list.notNull", "owner"), LIVE_INDEX, "accountId=?");
        expectWalks(single(page.statements, "list.null", "owner"), NULL_ACTIVITY_INDEX, "accountId=?)");
        // The attention family: the NOT NULL arm keeps its own `needsAttention` seek; the NULL arm
        // moves from that seek plus a temp b-tree to the NULL-activity index in order.
        const attentionNotNull = single(page.statements, "attention.notNull", "owner");
        expectWalks(attentionNotNull, ATTENTION_INDEX, "accountId=? AND needsAttention=?");
        expectNoNewIndex(attentionNotNull);
        expectWalks(single(page.statements, "attention.null", "owner"), NULL_ACTIVITY_INDEX, "accountId=?)");
        // The active family is ordered by `lastActiveAt`; neither partial index serves that order.
        for (const active of page.statements.filter((statement) => statement.kind === "active")) expectNoNewIndex(active);
        for (const shared of page.statements.filter((statement) => statement.arm === "shared")) expectNoNewIndex(shared);
    });
});
