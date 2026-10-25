import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createDeferred } from "@/testkit/async/deferred";
import {
  createApiSessionSocketStub,
  type ApiSessionSocketStub,
} from "@/testkit/backends/apiSessionSocketHarness";
import {
  createPlainSessionFixture,
  createSessionRecordFixture,
} from "@/testkit/backends/sessionFixtures";
import { MessageQueue2 } from "@/agent/runtime/modeMessageQueue";
import { createSessionProviderInputConsumer } from "@/agent/runtime/sessionInput/SessionProviderInputConsumer";
import type { PendingQueueDeliveryTiming } from "@/agent/runtime/sessionInput/types";
import type { UserMessage } from "@/api/types";
import { logger } from "@/ui/logger";

const boundary = vi.hoisted(() => {
  for (const key of [
    "HAPPIER_SERVER_URL",
    "HAPPIER_LOCAL_SERVER_URL",
    "HAPPIER_PUBLIC_SERVER_URL",
    "HAPPIER_WEBAPP_URL",
  ]) {
    vi.stubEnv(key, "https://relay.example.invalid");
  }
  vi.stubEnv("HAPPIER_HOME_DIR", `${process.env.TMPDIR}/pending-discovery-fixture`);
  return { get: vi.fn(), post: vi.fn(), beforeJournalRead: null as (() => Promise<void>) | null };
});
const origin = "https://relay.example.invalid";
const home = join(tmpdir(), "pending-discovery-fixture");
let sessionSocket: ApiSessionSocketStub;
let userSocket: ApiSessionSocketStub;

// Only HTTP, sockets, filesystem access, clock and randomness are replaced.
// Snapshot parsing, session custody, reconciliation, queue and input consumer stay real.
vi.mock("axios", async () => {
  const { createOfflineAxios } = await import("@/testkit/http/offlineAxios");
  return {
    default: {
      ...createOfflineAxios((url) => boundary.get(url)),
      post: (url: string, body: unknown) => {
        if (new URL(url).origin !== "https://relay.example.invalid") {
          throw new Error(`Offline HTTP boundary refused origin: ${new URL(url).origin}`);
        }
        return boundary.post(url, body);
      },
    },
  };
});
// The journal read is a filesystem boundary; all outbox/readiness logic stays real.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (
        boundary.beforeJournalRead
        && String(args[0]).endsWith("session-discovery-session.dead-letter.json")
      ) {
        await boundary.beforeJournalRead();
      }
      return actual.readFile(...args);
    },
  };
});
vi.mock("socket.io-client", () => ({
  io: (url: string, options: { auth: { clientType: string } }) => {
    if (url !== origin) throw new Error(`Offline socket refused origin: ${url}`);
    if (options.auth.clientType === "user-scoped") return userSocket;
    if (options.auth.clientType === "session-scoped") return sessionSocket;
    throw new Error("Unconfigured offline socket");
  },
}));
vi.mock("@/persistence", async (original) => ({
  ...(await original<typeof import("@/persistence")>()),
  readCredentials: async () => ({
    token: "synthetic-token",
    encryption: { type: "legacy", secret: new Uint8Array(32) },
  }),
}));

const features = {
  features: {
    sharing: { pendingQueueV2: { enabled: true }, pendingDeliveryState: { enabled: true } },
  },
  capabilities: {
    session: { runtimeActivity: { protocolVersion: 2 }, pendingInput: { protocolVersion: 1 } },
  },
};
let ApiSessionClient: (typeof import("./sessionClient"))["ApiSessionClient"];
const clients: import("./sessionClient").ApiSessionClient[] = [];
const controllers: AbortController[] = [];
let snapshot = createSessionRecordFixture({ id: "discovery-session" });
let readSnapshot: () => Promise<unknown>;
let readFeatures: () => Promise<Response>;
let materialize: () => Promise<unknown>;
let settle: (payload: unknown) => Promise<unknown>;
let accountDeliveryTiming: PendingQueueDeliveryTiming | undefined;
const detailReads = vi.fn();
const claims = vi.fn();
const settlements = vi.fn();

const originalPrompt = {
  role: "user" as const,
  content: { type: "text" as const, text: "Keep the exact input.\n第二行: α + β" },
  localId: "original-pending-local-id",
  meta: { source: "ui", sentFrom: "web" },
};

function claimed() {
  return {
    ok: true,
    didMaterialize: true,
    didWrite: false,
    localId: originalPrompt.localId,
    pendingCount: 1,
    pendingBlockedCount: 0,
    pendingVersion: 2,
    message: {
      id: "claimed-row",
      seq: null,
      localId: originalPrompt.localId,
      messageRole: "user",
      content: { t: "plain", v: originalPrompt },
      deliveryState: { mode: "provider", unresolved: true },
      requestedAction: { v: 1, kind: "enqueue" },
      providerAction: "send",
      createdAt: 1_000,
      updatedAt: 1_000,
    },
  };
}

function committed(didResolve = true) {
  const { deliveryState: _claimState, ...message } = claimed().message;
  return {
    ok: true,
    didResolve,
    pendingCount: 0,
    pendingBlockedCount: 0,
    pendingVersion: 3,
    message: { ...message, id: "committed-row", seq: 7 },
  };
}

function bind(
  client: import("./sessionClient").ApiSessionClient,
  matchesCurrentSession = () => true,
) {
  return client.bindProviderInputOutcomeProducer({
    providerId: "codex",
    mode: "unifiedTerminal",
    matchesCurrentSession,
  });
}

async function createClientWithoutProducer(pendingCount = 0) {
  sessionSocket = createApiSessionSocketStub({
    id: "discovery-session-socket",
    connected: false,
    emitWithAck: async (event, payload) => {
      if (event === "pending-materialize-next") {
        claims(payload);
        return materialize();
      }
      if (event === "pending-delivery-accepted-v1") {
        settlements(payload);
        return settle(payload);
      }
      const { resolveApiSessionSocketDefaultAck } =
        await import("@/testkit/backends/apiSessionSocketHarness");
      return resolveApiSessionSocketDefaultAck(event, payload);
    },
  });
  userSocket = createApiSessionSocketStub({ id: "discovery-user-socket", connected: false });
  const fixture = createPlainSessionFixture({
    id: snapshot.id,
    pendingCount,
    pendingBlockedCount: 0,
    pendingVersion: 0,
  });
  const client = new ApiSessionClient("synthetic-token", {
    ...fixture,
    metadata: {
      ...fixture.metadata,
      flavor: "codex",
      machineId: "discovery-machine",
      path: home,
      homeDir: home,
      happyHomeDir: home,
    },
  });
  clients.push(client);
  await client.getRuntimeActivitySnapshotPublisher().publish({ state: "idle", activeCount: 0 });
  await vi.waitFor(
    () => {
      const tail = client.readRuntimeActivitySnapshotTail();
      expect(tail.custody).toBeNull();
      expect(tail.settlement).not.toBeNull();
    },
    { timeout: 5_000 },
  );
  const settingsWait = new AbortController();
  const settingsReady = client.waitForPendingEligibilityUpdate(settingsWait.signal);
  await vi.waitFor(
    () => {
      const state = client as unknown as {
        accountSettingsRequestInFlight: Promise<unknown> | null;
        userSocketSettingsConvergedEpoch: number;
        userSocketSettingsConnectionEpoch: number;
      };
      expect(userSocket.connected).toBe(true);
      expect(state.accountSettingsRequestInFlight).toBeNull();
      expect(state.userSocketSettingsConvergedEpoch).toBe(state.userSocketSettingsConnectionEpoch);
    },
    { timeout: 5_000 },
  );
  settingsWait.abort();
  await settingsReady;
  await vi.advanceTimersByTimeAsync(0);
  detailReads.mockClear();
  return client;
}

async function createClient(pendingCount = 0) {
  const client = await createClientWithoutProducer(pendingCount);
  const observe = bind(client);
  await vi.advanceTimersByTimeAsync(0);
  detailReads.mockClear();
  return { client, observe };
}

function consume(
  client: import("./sessionClient").ApiSessionClient,
  pendingQueueDeliveryTiming?: PendingQueueDeliveryTiming,
) {
  const queue = new MessageQueue2<string, UserMessage>(() => "same-mode", {
    batcher: (messages) => messages[0]!,
  });
  client.onUserMessage((message, info) =>
    queue.push(message, "same-mode", {
      userMessageLocalId: message.localId,
      userMessageSeq: info?.seq,
      providerAcceptancePending: info?.providerAcceptancePending,
      pendingProviderAction: info?.pendingProviderAction,
    }),
  );
  const consumer = createSessionProviderInputConsumer({
    messageQueue: queue,
    session: client,
    reconcileWhenEmpty: "skip",
    ...(pendingQueueDeliveryTiming ? { pendingQueueDeliveryTiming } : {}),
  });
  const controller = new AbortController();
  controllers.push(controller);
  return { consumer, controller };
}

async function waitOnUnknownRuntimeActivity(bound: boolean) {
  accountDeliveryTiming = "after_runtime_idle";
  snapshot = { ...snapshot, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 };
  const client = bound
    ? (await createClient(1)).client
    : await createClientWithoutProducer(1);
  await client.reconcilePendingQueueState({ force: true });
  materialize = async () => ({
    ok: true,
    didMaterialize: false,
    pendingCount: 1,
    pendingBlockedCount: 0,
    pendingVersion: 1,
    deferredReason: "runtime_activity_unknown",
  });
  const eligibilityAt: number[] = [];
  client.on("pending-eligibility-updated", () => eligibilityAt.push(Date.now()));
  const { consumer, controller } = consume(client, "after_runtime_idle");
  const batches: unknown[] = [];
  const waiting = consumer.waitForNextInput({ abortSignal: controller.signal }).then((batch) => {
    if (batch) batches.push(batch);
    return batch;
  });
  await vi.advanceTimersByTimeAsync(0);
  // The initial claim and its exact-idle-revision retry both returned unknown. This
  // reaches the idle wait after the real runtime-tail helper has returned.
  expect(claims).toHaveBeenCalledTimes(2);
  expect(claims).toHaveBeenLastCalledWith(expect.objectContaining({
    deliveryTiming: "after_runtime_idle",
    foregroundState: "ready",
    expectedRuntimeActivityRevision: client.readRuntimeActivitySnapshotTail().settlement?.committedRevision,
  }));
  expect(eligibilityAt).toEqual([]);
  expect(batches).toEqual([]);
  expect(settlements).not.toHaveBeenCalled();
  return { client, consumer, controller, waiting, eligibilityAt, batches };
}

describe("authoritative pending discovery through the session client and consumer", () => {
  beforeAll(async () => {
    for (const key of [
      "HAPPIER_SERVER_URL",
      "HAPPIER_LOCAL_SERVER_URL",
      "HAPPIER_PUBLIC_SERVER_URL",
      "HAPPIER_WEBAPP_URL",
    ])
      vi.stubEnv(key, origin);
    vi.stubEnv("HAPPIER_HOME_DIR", home);
    vi.stubEnv("HAPPY_ENABLE_V2_CHANGES", "0");
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.origin !== origin || url.pathname !== "/v1/features")
        throw new Error(`Unconfigured offline fetch: ${url.href}`);
      return readFeatures();
    });
    const { reloadConfiguration } = await import("@/configuration");
    reloadConfiguration();
    ({ ApiSessionClient } = await import("./sessionClient"));
  }, 120_000);
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T00:00:00Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    snapshot = createSessionRecordFixture({
      id: "discovery-session",
      encryptionMode: "plain",
      latestTurnStatus: "completed",
      pendingCount: 0,
      pendingBlockedCount: 0,
      pendingVersion: 0,
    });
    readSnapshot = async () => ({ status: 200, data: { session: snapshot } });
    readFeatures = async () => new Response(JSON.stringify(features), { status: 200 });
    materialize = async () => claimed();
    settle = async () => committed();
    accountDeliveryTiming = undefined;
    detailReads.mockClear();
    claims.mockClear();
    settlements.mockClear();
    boundary.post.mockReset().mockRejectedValue(new Error("Unconfigured offline HTTP POST"));
    boundary.get.mockReset().mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === `/v2/sessions/${snapshot.id}`) {
        detailReads(Date.now());
        return readSnapshot();
      }
      if (path === "/v1/account/profile") return { status: 200, data: { id: "discovery-account" } };
      if (path === "/v1/access-keys/discovery-session/discovery-machine")
        return { status: 200, data: { accessKey: "synthetic-machine-binding" } };
      if (path === "/v2/account/settings")
        return {
          status: 200,
          data: {
            version: 1,
            content: {
              t: "plain",
              v: {
                schemaVersion: 6,
                ...(accountDeliveryTiming ? { sessionPendingQueueDeliveryTiming: accountDeliveryTiming } : {}),
              },
            },
          },
        };
      if (path === "/health") return { status: 200, data: {} };
      if (path === "/v1/features") return { status: 200, data: features };
      if (path === "/v2/changes") return { status: 200, data: { changes: [], nextCursor: 0 } };
      if (path.endsWith("/pending")) return { status: 200, data: { pending: [], messages: [] } };
      if (path.endsWith("/messages"))
        return { status: 200, data: { messages: [], hasMore: false } };
      throw new Error(`Unconfigured offline GET: ${url}`);
    });
  });
  afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.abort();
    for (const client of clients.splice(0)) {
      client.beginRuntimeTermination();
      await client.close();
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([false, true])(
    "reconsiders unknown runtime activity at the existing minute cadence with provider already bound=%s",
    async (bound) => {
      const { controller, waiting, eligibilityAt, batches } = await waitOnUnknownRuntimeActivity(bound);
      const startedAt = Date.now();
      try {
        await vi.advanceTimersByTimeAsync(59_999);
        expect(claims).toHaveBeenCalledTimes(2);
        expect(eligibilityAt).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(eligibilityAt).toEqual([startedAt + 60_000]);
        expect(claims.mock.calls.length).toBeGreaterThan(2);
        // Reconsideration does not make an unknown runtime admissible or prove acceptance.
        expect(batches).toEqual([]);
        expect(settlements).not.toHaveBeenCalled();
      } finally {
        controller.abort();
        await waiting;
      }
    },
  );

  it.each(["close", "termination"] as const)(
    "retires pre-provider unknown-activity reconsideration on %s",
    async (loss) => {
      const { client, controller, waiting, eligibilityAt, batches } = await waitOnUnknownRuntimeActivity(false);
      try {
        if (loss === "close") await client.close();
        else client.beginRuntimeTermination();
        await vi.advanceTimersByTimeAsync(180_000);
        expect(claims).toHaveBeenCalledTimes(2);
        expect(eligibilityAt).toEqual([]);
        expect(batches).toEqual([]);
        expect(settlements).not.toHaveBeenCalled();
      } finally {
        controller.abort();
        await waiting;
      }
    },
  );

  it("retires an old binding's reconsideration deadline when the current provider rebinds", async () => {
    const { client, controller, waiting, eligibilityAt, batches } = await waitOnUnknownRuntimeActivity(true);
    const startedAt = Date.now();
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      bind(client);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(eligibilityAt).toEqual([]);
      expect(claims).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(eligibilityAt).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(eligibilityAt).toEqual([startedAt + 90_000]);
      expect(claims.mock.calls.length).toBeGreaterThan(2);
      expect(batches).toEqual([]);
      expect(settlements).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await waiting;
    }
  });

  it.each([false, true])(
    "claims an admissible input once when duplicate eligibility wakes meet the minute deadline, bound=%s",
    async (bound) => {
      const { client, controller, waiting, batches } = await waitOnUnknownRuntimeActivity(bound);
      try {
        await vi.advanceTimersByTimeAsync(59_999);
        expect(batches).toEqual([]);
        expect(settlements).not.toHaveBeenCalled();
        materialize = async () => claimed();
        setTimeout(() => {
          client.emit("pending-eligibility-updated");
          client.emit("pending-eligibility-updated");
        }, 1);
        await vi.advanceTimersByTimeAsync(1);
        await expect(waiting).resolves.toMatchObject({
          message: { ...originalPrompt, createdAt: 1_000 },
          userMessageLocalIds: [originalPrompt.localId],
        });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(claims).toHaveBeenCalledTimes(3);
        expect(batches).toHaveLength(1);
        expect(settlements).not.toHaveBeenCalled();
      } finally {
        controller.abort();
        await waiting;
      }
    },
  );

  it("does not reoffer through a positive-generation producer that no longer matches the session", async () => {
    const { client, controller, waiting, eligibilityAt, batches } = await waitOnUnknownRuntimeActivity(true);
    let matches = true;
    bind(client, () => matches);
    matches = false;
    try {
      await vi.advanceTimersByTimeAsync(180_000);
      expect(claims).toHaveBeenCalledTimes(2);
      expect(eligibilityAt).toEqual([]);
      expect(batches).toEqual([]);
      expect(settlements).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await waiting;
    }
  });

  it("does not regain bootstrap reoffers after a permanent discovery failure clears a bound producer", async () => {
    const { controller, waiting, eligibilityAt, batches } = await waitOnUnknownRuntimeActivity(true);
    detailReads.mockClear();
    readSnapshot = async () => ({ status: 400, data: { error: "invalid-session-request" } });
    try {
      await vi.advanceTimersByTimeAsync(300_000);
      expect(detailReads).toHaveBeenCalledTimes(1);
      const claimCount = claims.mock.calls.length;
      const eligibilityCount = eligibilityAt.length;
      expect(claimCount).toBeGreaterThan(2);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(detailReads).toHaveBeenCalledTimes(1);
      expect(claims).toHaveBeenCalledTimes(claimCount);
      expect(eligibilityAt).toHaveLength(eligibilityCount);
      expect(batches).toEqual([]);
      expect(settlements).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await waiting;
    }
  });

  it("retires a bootstrap reoffer after an authoritative archived snapshot", async () => {
    const { client, controller, waiting, eligibilityAt, batches } = await waitOnUnknownRuntimeActivity(false);
    snapshot = { ...snapshot, archivedAt: Date.now() };
    try {
      await client.reconcilePendingQueueState({ force: true });
      expect(detailReads).toHaveBeenCalledTimes(2);
      expect(client.shouldAttemptPendingMaterialization()).toBe(false);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(claims).toHaveBeenCalledTimes(2);
      expect(eligibilityAt).toEqual([]);
      expect(batches).toEqual([]);
      expect(settlements).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await waiting;
    }
  });

  it("re-offers blocked-only pending work after 60 seconds without another hint", async () => {
    snapshot = { ...snapshot, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 1 };
    const { client } = await createClient();
    await client.reconcilePendingQueueState({ force: true });
    const { consumer, controller } = consume(client);
    let delivered: Awaited<ReturnType<typeof consumer.waitForNextInput>> | undefined;
    const waiting = consumer.waitForNextInput({ abortSignal: controller.signal }).then((batch) => { delivered = batch; });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(claims).not.toHaveBeenCalled();
    // An unchanged snapshot must not postpone the already armed attempt.
    await client.reconcilePendingQueueState({ force: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered?.message).toEqual({ ...originalPrompt, createdAt: 1_000 });
    expect(claims).toHaveBeenCalledWith(expect.objectContaining({
      foregroundState: "ready", heldLocalIds: [],
    }));
    controller.abort();
    await waiting;
  });

  it("repeats a delayed blocked-row attempt and stops when the authoritative blocked count clears", async () => {
    snapshot = { ...snapshot, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 1 };
    const { client } = await createClient();
    await client.reconcilePendingQueueState({ force: true });
    materialize = async () => ({ ok: true, didMaterialize: false, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 1 });
    const { consumer, controller } = consume(client);
    const waiting = consumer.waitForNextInput({ abortSignal: controller.signal });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(claims).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(claims).toHaveBeenCalledTimes(2);
    snapshot = { ...snapshot, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 2 };
    await client.reconcilePendingQueueState({ force: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(claims).toHaveBeenCalledTimes(2);
    controller.abort();
    await waiting;
  });

  it("retries through the real consumer 60 seconds after a successful claim becomes delayed-blocked", async () => {
    snapshot = { ...snapshot, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 };
    const { client } = await createClient();
    await client.reconcilePendingQueueState({ force: true });
    const { consumer, controller } = consume(client);
    const first = await consumer.waitForNextInput({ abortSignal: controller.signal });
    expect(first?.message.localId).toBe(originalPrompt.localId);
    expect(claims).toHaveBeenCalledTimes(1);
    detailReads.mockClear();
    boundary.post.mockResolvedValueOnce({
      status: 200,
      data: { ok: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 3 },
    });
    await expect(client.blockPendingMessageDelivery({
      localIds: [originalPrompt.localId], reason: "provider_unavailable_before_acceptance", providerEffect: "none",
    })).resolves.toBe(true);
    expect(boundary.post).toHaveBeenCalledWith(
      `${origin}/v2/sessions/${snapshot.id}/pending/${originalPrompt.localId}/delivery/block`,
      { reason: "provider_unavailable_before_acceptance" },
    );
    const replacementPrompt = { ...originalPrompt, localId: "replacement-after-delayed-block" };
    materialize = async () => ({
      ...claimed(), localId: replacementPrompt.localId, pendingVersion: 4,
      message: { ...claimed().message, localId: replacementPrompt.localId, content: { t: "plain", v: replacementPrompt } },
    });
    let next: Awaited<ReturnType<typeof consumer.waitForNextInput>> | undefined;
    const waiting = consumer.waitForNextInput({ abortSignal: controller.signal }).then((batch) => { next = batch; });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(claims).toHaveBeenCalledTimes(1);
    expect(detailReads).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(claims).toHaveBeenCalledTimes(2);
    expect(next?.message).toEqual({ ...replacementPrompt, createdAt: 1_000 });
    expect(detailReads).not.toHaveBeenCalled();
    controller.abort();
    await waiting;
  });

  it("rearms the minute retry when blocked A remains after successful claim and settlement of B", async () => {
    snapshot = { ...snapshot, pendingCount: 2, pendingBlockedCount: 1, pendingVersion: 1 };
    const { client, observe } = await createClient();
    await client.reconcilePendingQueueState({ force: true });
    materialize = async () => ({ ...claimed(), pendingCount: 2, pendingBlockedCount: 1 });
    const { consumer, controller } = consume(client);
    const first = await consumer.waitForNextInput({ abortSignal: controller.signal });
    expect(first?.message.localId).toBe(originalPrompt.localId);
    expect(claims).toHaveBeenCalledTimes(1);
    detailReads.mockClear();
    settle = async () => ({ ...committed(), pendingCount: 1, pendingBlockedCount: 1 });
    observe({ kind: "accepted", localId: originalPrompt.localId });
    await vi.advanceTimersByTimeAsync(0);
    expect(settlements).toHaveBeenCalledTimes(1);
    expect(client.hasCanonicalPendingProviderInputDelivery(originalPrompt.localId)).toBe(false);
    const replacementPrompt = { ...originalPrompt, localId: "replacement-of-blocked-A" };
    materialize = async () => ({
      ...claimed(), localId: replacementPrompt.localId, pendingVersion: 4,
      message: { ...claimed().message, localId: replacementPrompt.localId, content: { t: "plain", v: replacementPrompt } },
    });
    let next: Awaited<ReturnType<typeof consumer.waitForNextInput>> | undefined;
    const waiting = consumer.waitForNextInput({ abortSignal: controller.signal }).then((batch) => { next = batch; });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(claims).toHaveBeenCalledTimes(1);
    expect(detailReads).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(claims).toHaveBeenCalledTimes(2);
    expect(next?.message).toEqual({ ...replacementPrompt, createdAt: 1_000 });
    expect(detailReads).not.toHaveBeenCalled();
    controller.abort();
    await waiting;
  });

  it("arms the minute retry from a blocked-only hint after an empty authoritative discovery", async () => {
    const { client } = await createClient();
    await client.reconcilePendingQueueState({ force: true });
    const { consumer, controller } = consume(client);
    let delivered: Awaited<ReturnType<typeof consumer.waitForNextInput>> | undefined;
    const waiting = consumer.waitForNextInput({ abortSignal: controller.signal }).then((batch) => { delivered = batch; });
    await vi.advanceTimersByTimeAsync(0);
    userSocket.trigger("update", {
      id: "blocked-after-empty-discovery", seq: 2, createdAt: Date.now(),
      body: { t: "pending-changed", sid: snapshot.id, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 1 },
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(claims).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(claims).toHaveBeenCalledTimes(1);
    expect(delivered?.message).toEqual({ ...originalPrompt, createdAt: 1_000 });
    controller.abort();
    await waiting;
  });

  it("re-offers an external-handoff-only queue after an early no-claim response without another hint", async () => {
    snapshot = { ...snapshot, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 };
    const { client } = await createClient();
    await client.reconcilePendingQueueState({ force: true });
    const startedAt = Date.now();
    materialize = async () => Date.now() - startedAt >= 60_000 ? claimed() : ({
      ok: true, didMaterialize: false, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1,
    });
    const { consumer, controller } = consume(client);
    let delivered: Awaited<ReturnType<typeof consumer.waitForNextInput>> | undefined;
    const waiting = consumer.waitForNextInput({ abortSignal: controller.signal }).then((batch) => { delivered = batch; });
    await vi.advanceTimersByTimeAsync(0);
    expect(claims).toHaveBeenCalledTimes(1);
    expect(delivered).toBeUndefined();
    await vi.advanceTimersByTimeAsync(59_999);
    await client.reconcilePendingQueueState({ force: true });
    expect(claims).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(claims).toHaveBeenCalledTimes(2);
    expect(delivered?.message).toEqual({ ...originalPrompt, createdAt: 1_000 });
    controller.abort();
    await waiting;
  });

  it("repeats minute attempts while an old-server head stays held despite healthy unchanged discovery", async () => {
    snapshot = { ...snapshot, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 };
    const { client } = await createClient();
    await client.reconcilePendingQueueState({ force: true });
    materialize = async () => ({
      ok: true, didMaterialize: false, deferredReason: 'waiting_for_predecessor',
      pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1,
    });
    const { consumer, controller } = consume(client);
    const waiting = consumer.waitForNextInput({ abortSignal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(claims).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(detailReads).toHaveBeenCalled();
    expect(claims).toHaveBeenCalledTimes(6);
    snapshot = { ...snapshot, pendingCount: 0, pendingVersion: 2 };
    await client.reconcilePendingQueueState({ force: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(claims).toHaveBeenCalledTimes(6);
    controller.abort();
    await waiting;
  });

  it("discovers a completely missed hint from cached empty and delivers the complete original input once", async () => {
    const { client, observe } = await createClient();
    const { consumer, controller } = consume(client);
    let batch: Awaited<ReturnType<typeof consumer.waitForNextInput>> | undefined;
    const waiting = consumer.waitForNextInput({ abortSignal: controller.signal }).then((value) => {
      batch = value;
    });
    await vi.advanceTimersByTimeAsync(0);
    snapshot = { ...snapshot, pendingCount: 1, pendingVersion: 1 };
    await vi.advanceTimersByTimeAsync(299_999);
    expect(claims).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(detailReads.mock.calls).toEqual([[Date.now()]]);
    expect(claims).toHaveBeenCalledTimes(1);
    expect(batch?.message).toEqual({ ...originalPrompt, createdAt: 1_000 });
    expect(batch?.userMessageLocalIds).toEqual([originalPrompt.localId]);
    expect(claims).toHaveBeenCalledTimes(1);
    let providerEntries = 0;
    await consumer.runProviderInputDispatch({
      abortSignal: controller.signal,
      dispatch: async () => {
        providerEntries += 1;
        observe({ kind: "accepted", localId: originalPrompt.localId });
      },
    });
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(providerEntries).toBe(1);
    expect(claims).toHaveBeenCalledTimes(1);
    expect(settlements.mock.calls.map(([payload]) => payload)).toEqual([
      { v: 1, sessionId: snapshot.id, localId: originalPrompt.localId },
    ]);
    controller.abort();
    await waiting;
  });

  it("stretches cadence after slow successful reads, restores it after a fast read, and never reads during a provider turn", async () => {
    const { client } = await createClient();
    const slow = createDeferred<unknown>();
    readSnapshot = () => slow.promise;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(detailReads).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_000);
    slow.resolve({ status: 200, data: { session: snapshot } });
    await vi.advanceTimersByTimeAsync(0);
    readSnapshot = async () => ({ status: 200, data: { session: snapshot } });
    await vi.advanceTimersByTimeAsync(1_199_999);
    expect(detailReads).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(detailReads).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(detailReads).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(detailReads).toHaveBeenCalledTimes(3);
    await client.sessionTurnLifecycle.beginTurn({ provider: "codex" });
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(detailReads).toHaveBeenCalledTimes(3);
    await client.sessionTurnLifecycle.completeTurn({ provider: "codex" });
    await vi.advanceTimersByTimeAsync(0);
    expect(detailReads).toHaveBeenCalledTimes(4);
  });

  it("honors a Retry-After longer than the local cadence cap", async () => {
    const { client } = await createClient();
    readSnapshot = async () => ({ status: 429, headers: { "retry-after": "3600" }, data: {} });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(detailReads).toHaveBeenCalledTimes(1);
    readSnapshot = async () => ({ status: 200, data: { session: snapshot } });
    bind(client);
    await vi.advanceTimersByTimeAsync(3_599_999);
    expect(detailReads).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(detailReads).toHaveBeenCalledTimes(2);
  });

  it("preserves a held old-generation Retry-After after rebind without renewing eligibility", async () => {
    const { client } = await createClient();
    const eligibilityUpdates = vi.fn();
    client.on("pending-eligibility-updated", eligibilityUpdates);
    const response = createDeferred<unknown>();
    readSnapshot = () => response.promise;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(detailReads).toHaveBeenCalledTimes(1);
    bind(client);
    await vi.advanceTimersByTimeAsync(1_000);
    response.resolve({ status: 429, headers: { "retry-after": "3600" }, data: {} });
    await vi.advanceTimersByTimeAsync(0);
    readSnapshot = async () => ({ status: 200, data: { session: snapshot } });
    await vi.advanceTimersByTimeAsync(3_599_999);
    expect(detailReads).toHaveBeenCalledTimes(1);
    expect(eligibilityUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(detailReads).toHaveBeenCalledTimes(2);
    expect(eligibilityUpdates).not.toHaveBeenCalled();
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);
    expect(claims).not.toHaveBeenCalled();
    expect(settlements).not.toHaveBeenCalled();
  });

  it("chunks a finite Retry-After beyond the timer range and rechecks its full deadline before reading", async () => {
    await createClient();
    const response = createDeferred<unknown>();
    readSnapshot = () => response.promise;
    await vi.advanceTimersByTimeAsync(300_000);
    const timers: Array<{ delayMs: number; fire: () => void }> = [];
    // Capture only the external timer boundary, avoiding millions of unrelated ticks
    // while exercising a finite server floor just beyond Node's supported timer range.
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fire: () => void, delay?: number) => {
      timers.push({ delayMs: Number(delay ?? 0), fire });
      return { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
    response.resolve({ status: 429, headers: { "retry-after": "2147484" }, data: {} });
    await vi.advanceTimersByTimeAsync(0);
    const serverDeadline = Date.now() + 2_147_484_000;
    const first = timers.at(-1)!;
    expect(first.delayMs).toBe(2_147_483_647);
    readSnapshot = async () => ({ status: 200, data: { session: snapshot } });
    vi.setSystemTime(Date.now() + first.delayMs);
    first.fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(detailReads).toHaveBeenCalledTimes(1);
    const rearmed = timers.at(-1)!;
    expect(rearmed).not.toBe(first);
    expect(rearmed.delayMs).toBeGreaterThanOrEqual(serverDeadline - Date.now());
    vi.setSystemTime(serverDeadline - 1);
    rearmed.fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(detailReads).toHaveBeenCalledTimes(1);
    const deadlineTimer = timers.at(-1)!;
    expect(deadlineTimer).not.toBe(rearmed);
    vi.setSystemTime(serverDeadline);
    deadlineTimer.fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(detailReads).toHaveBeenCalledTimes(2);
    expect(timers.every(({ delayMs }) => delayMs <= 2_147_483_647)).toBe(true);
    expect(claims).not.toHaveBeenCalled();
    expect(settlements).not.toHaveBeenCalled();
  });

  it("never starts a paginated compatibility scan from periodic discovery when the detail route is absent", async () => {
    await createClient();
    readSnapshot = async () => ({
      status: 404,
      data: { error: "Not found", path: `/v2/sessions/${snapshot.id}` },
    });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(detailReads).toHaveBeenCalledTimes(1);
    expect(boundary.get.mock.calls.map(([url]) => new URL(url).pathname)).not.toContain(
      "/v2/sessions",
    );
    expect(claims).not.toHaveBeenCalled();
  });

  it("keeps one read in flight and applies the maximum slow cadence and both healthy jitter bounds", async () => {
    const { client } = await createClient();
    const response = createDeferred<unknown>();
    readSnapshot = () => response.promise;
    await vi.advanceTimersByTimeAsync(300_000);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(detailReads).toHaveBeenCalledTimes(1);
    vi.mocked(Math.random).mockReturnValue(0);
    response.resolve({ status: 200, data: { session: snapshot } });
    await vi.advanceTimersByTimeAsync(0);
    readSnapshot = async () => ({ status: 200, data: { session: snapshot } });
    await vi.advanceTimersByTimeAsync(1_439_999);
    expect(detailReads).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(detailReads).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(239_999);
    expect(detailReads).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(detailReads).toHaveBeenCalledTimes(3);
    vi.mocked(Math.random).mockReturnValue(1 - Number.EPSILON);
    bind(client);
    await vi.advanceTimersByTimeAsync(359_999);
    expect(detailReads).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(detailReads).toHaveBeenCalledTimes(4);
  });

  it("defers reads while actual connection readiness is unsettled and resumes one timer after convergence", async () => {
    const { client } = await createClient();
    const state = client as unknown as {
      sessionConnectionEpoch: number;
      sessionSyncPendingInputServerContract: { sessionConnectionEpoch: number } | null;
      pendingInputReadinessAbortController: AbortController | null;
      pendingDiscoveryTimer: unknown;
    };
    const response = createDeferred<Response>();
    readFeatures = () => response.promise;
    sessionSocket.trigger("connect");
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(detailReads).not.toHaveBeenCalled();
    expect(claims).not.toHaveBeenCalled();
    const journalReadStarted = createDeferred<void>();
    const releaseJournalRead = createDeferred<void>();
    boundary.beforeJournalRead = async () => {
      journalReadStarted.resolve();
      await releaseJournalRead.promise;
    };
    try {
      response.resolve(new Response(JSON.stringify(features), { status: 200 }));
      await journalReadStarted.promise;
      // Features are resolved, but outbox convergence still owns this filesystem read.
      await vi.advanceTimersByTimeAsync(300_000);
      expect(detailReads).not.toHaveBeenCalled();
      expect(claims).not.toHaveBeenCalled();
    } finally {
      boundary.beforeJournalRead = null;
      releaseJournalRead.resolve();
    }
    // Observe real filesystem convergence without moving the discovery clock.
    await vi.waitFor(
      () => {
        expect(state.sessionSyncPendingInputServerContract?.sessionConnectionEpoch)
          .toBe(state.sessionConnectionEpoch);
        expect(state.pendingInputReadinessAbortController).toBeNull();
        expect(state.pendingDiscoveryTimer).not.toBeNull();
      },
      { timeout: 5_000, interval: 0 },
    );
    await vi.advanceTimersByTimeAsync(299_999);
    expect(detailReads).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(detailReads).toHaveBeenCalledTimes(1);
  });

  it("retains reserved input until the watchdog deadline and settles a lost ACK without another provider entry", async () => {
    const { client, observe } = await createClient();
    const { consumer, controller } = consume(client);
    const waiting = consumer.waitForNextInput({ abortSignal: controller.signal });
    snapshot = { ...snapshot, pendingCount: 1, pendingVersion: 1 };
    await vi.advanceTimersByTimeAsync(300_000);
    expect(claims).toHaveBeenCalledTimes(1);
    const batch = await waiting;
    expect(batch?.message).toEqual({ ...originalPrompt, createdAt: 1_000 });
    const readsAtReservation = detailReads.mock.calls.length;
    await vi.advanceTimersByTimeAsync(119_999);
    await expect(consumer.drainPending({ abortSignal: controller.signal })).resolves.toMatchObject({
      materialized: 0,
    });
    expect(claims).toHaveBeenCalledTimes(1);
    const ack = createDeferred<unknown>();
    settle = () => ack.promise;
    let providerEntries = 0;
    await consumer.runProviderInputDispatch({
      abortSignal: controller.signal,
      dispatch: async () => {
        providerEntries += 1;
        observe({ kind: "accepted", localId: originalPrompt.localId });
      },
    });
    // Stay inside the existing socket ACK deadline: the unsettled acceptance still owns
    // its operation. Its own timeout/retry policy is distinct from this discovery timer.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.hasPendingProviderInputAcceptance(originalPrompt.localId)).toBe(true);
    expect(client.hasCanonicalPendingProviderInputDelivery(originalPrompt.localId)).toBe(true);
    expect(detailReads).toHaveBeenCalledTimes(readsAtReservation);
    expect(settlements).toHaveBeenCalledTimes(1);
    // Server absence is not exact accepted-settlement proof.
    await client.reconcilePendingQueueState({ force: true });
    expect(client.hasCanonicalPendingProviderInputDelivery(originalPrompt.localId)).toBe(true);
    snapshot = { ...snapshot, pendingCount: 0, pendingVersion: 3 };
    settle = async () => committed(false);
    ack.reject(new Error("socket has been disconnected after commit"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.hasCanonicalPendingProviderInputDelivery(originalPrompt.localId)).toBe(false);
    expect(client.getCommittedUserMessageSeq(originalPrompt.localId)).toBe(7);
    expect(providerEntries).toBe(1);
    expect(claims).toHaveBeenCalledTimes(1);
    expect(settlements.mock.calls.map(([payload]) => payload)).toEqual([
      { v: 1, sessionId: snapshot.id, localId: originalPrompt.localId },
      { v: 1, sessionId: snapshot.id, localId: originalPrompt.localId },
    ]);
  });

  it("delivers later input through the consumer while an accepted settlement remains unfinished", async () => {
    const { client, observe } = await createClient();
    const { consumer, controller } = consume(client);
    const waiting = consumer.waitForNextInput({ abortSignal: controller.signal });
    snapshot = { ...snapshot, pendingCount: 1, pendingVersion: 1 };
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await waiting).toBeTruthy();
    settle = async () => ({ ok: false, error: "transcript-conflict" });
    await consumer.runProviderInputDispatch({
      abortSignal: controller.signal,
      dispatch: async () => { observe({ kind: "accepted", localId: originalPrompt.localId }); },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settlements).toHaveBeenCalledTimes(1);
    expect(client.hasCanonicalPendingProviderInputDelivery(originalPrompt.localId)).toBe(true);
    snapshot = { ...snapshot, pendingCount: 2, pendingVersion: 4 };
    const laterPrompt = { ...originalPrompt, localId: "later-after-unsettled-acceptance" };
    materialize = async () => ({
      ...claimed(), localId: laterPrompt.localId, pendingVersion: 5,
      message: { ...claimed().message, localId: laterPrompt.localId, content: { t: "plain", v: laterPrompt } },
    });
    await client.reconcilePendingQueueState({ force: true });
    await expect(consumer.drainPending({ abortSignal: controller.signal })).resolves.toMatchObject({ materialized: 1 });
    expect(claims.mock.calls[1]?.[0]).toMatchObject({ heldLocalIds: [originalPrompt.localId] });
    const later = await consumer.waitForNextInput({ abortSignal: controller.signal });
    expect(later?.message.localId).toBe(laterPrompt.localId);
    expect(client.hasCanonicalPendingProviderInputDelivery(originalPrompt.localId)).toBe(true);
  });

  it("keeps transport failures bounded until read recovery, then renews minute attempts while pending rows remain", async () => {
    const { client } = await createClient(1);
    const { consumer, controller } = consume(client);
    readSnapshot = async () => {
      throw new Error("network error while reading snapshot");
    };
    materialize = async () => {
      throw new Error("socket has been disconnected");
    };
    const attempts = vi.spyOn(client, "materializeNextPendingMessageSafely");
    const waiting = consumer.waitForNextInput({ abortSignal: controller.signal });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(attempts).toHaveBeenCalledTimes(12);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(attempts).toHaveBeenCalledTimes(12);
    snapshot = { ...snapshot, pendingCount: 1, pendingVersion: 0 };
    readSnapshot = async () => ({ status: 200, data: { session: snapshot } });
    materialize = async () => ({
      ok: true, didMaterialize: false, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 0,
    });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(attempts.mock.calls.length).toBeGreaterThan(12);
    const afterRecovery = attempts.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toHaveBeenCalledTimes(afterRecovery + 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toHaveBeenCalledTimes(afterRecovery + 2);
    controller.abort();
    await waiting;
  });

  it.each([0, 1])(
    "coalesces timer, hint and turn-end with stale pendingCount=%i in one in-flight read",
    async (pendingCount) => {
      const { client } = await createClient(pendingCount);
      const response = createDeferred<unknown>();
      readSnapshot = () => response.promise;
      await vi.advanceTimersByTimeAsync(299_999);
      await client.sessionTurnLifecycle.beginTurn({ provider: "codex" });
      await client.sessionTurnLifecycle.completeTurn({ provider: "codex" });
      await vi.advanceTimersByTimeAsync(1);
      expect(detailReads).toHaveBeenCalledTimes(1);
      userSocket.trigger("update", {
        id: "hint-during-read",
        seq: 2,
        createdAt: Date.now(),
        body: {
          t: "pending-changed",
          sid: snapshot.id,
          pendingCount: 1,
          pendingBlockedCount: 0,
          pendingVersion: 2,
        },
      });
      expect(detailReads).toHaveBeenCalledTimes(1);
      response.resolve({
        status: 200,
        data: { session: { ...snapshot, pendingCount: 0, pendingVersion: 1 } },
      });
      readSnapshot = async () => ({
        status: 200,
        data: { session: { ...snapshot, pendingCount: 1, pendingVersion: 2 } },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(client.shouldAttemptPendingMaterialization()).toBe(true);
      expect(detailReads.mock.calls.length).toBeLessThanOrEqual(2);
      expect(claims).not.toHaveBeenCalled();
    },
  );

  it("does not create an additional read while actual settings convergence is unsettled", async () => {
    const { client } = await createClient();
    const settings = createDeferred<unknown>();
    boundary.get.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/v1/account/profile") return { status: 200, data: { id: "discovery-account" } };
      if (path === "/v2/account/settings") return settings.promise;
      if (path === `/v2/sessions/${snapshot.id}`) {
        detailReads(Date.now());
        return readSnapshot();
      }
      throw new Error(`Unconfigured held-settings GET: ${url}`);
    });
    const controller = new AbortController();
    controllers.push(controller);
    const waiting = client.waitForPendingEligibilityUpdate(controller.signal);
    userSocket.trigger("connect");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(detailReads).not.toHaveBeenCalled();
    expect(claims).not.toHaveBeenCalled();
    controller.abort();
    await waiting;
    settings.resolve({
      status: 200,
      data: { version: 2, content: { t: "plain", v: { schemaVersion: 6 } } },
    });
    await vi.advanceTimersByTimeAsync(0);
  });

  it.each(["close", "termination", "producer", "connection", "disconnect", "machine"] as const)(
    "fences an old response after %s and does not dispatch it",
    async (loss) => {
      const { client } = await createClient();
      const response = createDeferred<unknown>();
      readSnapshot = () => response.promise;
      await vi.advanceTimersByTimeAsync(300_000);
      const state = client as unknown as {
        sessionConnectionEpoch: number;
        sessionSocketMachineId?: string;
      };
      const closing = loss === "close" ? client.close() : null;
      if (loss === "termination") client.beginRuntimeTermination();
      if (loss === "producer") bind(client);
      if (loss === "connection") state.sessionConnectionEpoch += 1;
      if (loss === "disconnect") {
        sessionSocket.connected = false;
        sessionSocket.trigger("disconnect", "transport close");
      }
      if (loss === "machine") state.sessionSocketMachineId = "replacement-machine";
      response.resolve({
        status: 200,
        data: { session: { ...snapshot, pendingCount: 1, pendingVersion: 1 } },
      });
      await vi.advanceTimersByTimeAsync(0);
      await closing;
      expect(client.shouldAttemptPendingMaterialization()).toBe(false);
      expect(claims).not.toHaveBeenCalled();
    },
  );

  it("stops discovery on an authoritative archived snapshot without entering the provider", async () => {
    const { client } = await createClient();
    snapshot = { ...snapshot, archivedAt: Date.now(), pendingCount: 1, pendingVersion: 1 };
    await vi.advanceTimersByTimeAsync(300_000);
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);
    await expect(client.materializeNextPendingMessageSafely()).resolves.toEqual({
      type: "no_pending",
    });
    await expect(client.popPendingMessage()).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(7_200_000);
    expect(detailReads).toHaveBeenCalledTimes(1);
    expect(claims).not.toHaveBeenCalled();
  });
});
