import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import axios from 'axios';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { encrypt, encodeBase64 } from '@/api/encryption';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import { createSessionRuntimeActivity } from '@/session/runtimeActivity/createSessionRuntimeActivity';
import type { Session, UserMessage } from '@/api/types';
import { createTestAuth } from '../../../src/testkit/auth';
import { fetchJson } from '../../../src/testkit/http';
import { listPendingQueueV2 } from '../../../src/testkit/pendingQueueV2';
import { createMachineBoundSessionScopedSocketCollector } from '../../../src/testkit/sessionSocketBinding';
import { createSessionWithCiphertexts, fetchAllMessages, fetchSessionV2 } from '../../../src/testkit/sessions';
import { waitFor } from '../../../src/testkit/timing';

const server = { baseUrl: process.argv[2]! };
const scenario = process.argv[3]!;
const collision = scenario === 'collision';
const run = { runDir: process.argv[4]! };
const custodyTimeoutMs = 987_654_321;

async function main() {
    const auth = await createTestAuth(server.baseUrl);
    const key = new Uint8Array(randomBytes(32));
    const metadata = {
      path: run.runDir, host: 'turnover-test', homeDir: run.runDir, happyHomeDir: run.runDir,
      happyLibDir: run.runDir, happyToolsDir: run.runDir, flavor: 'codex' as const,
    };
    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: server.baseUrl, token: auth.token,
      metadataCiphertextBase64: encodeBase64(encrypt(key, 'legacy', metadata)),
    });
    const binding = await createMachineBoundSessionScopedSocketCollector({
      baseUrl: server.baseUrl, token: auth.token, sessionId,
    });
    const activity = createSessionRuntimeActivity('supported');
    await activity.agentRuntimeContributionHandle!.report({ state: 'idle', activeCount: 0 }, 'controlled provider idle');
    const record = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
    const session: Session = {
      id: sessionId, seq: 0, metadata: { ...metadata, machineId: binding.machineId },
      metadataVersion: record.metadataVersion, agentState: null, agentStateVersion: record.agentStateVersion,
      encryptionMode: 'e2ee', encryptionKey: key, encryptionVariant: 'legacy',
      pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 0,
    };
    const client = new ApiSessionClient(auth.token, session, {
      executionRunContributionHandle: activity.executionRunsContributionHandle,
    });
    const state = client as unknown as {
      sessionConnectionEpoch: number;
      socket: { connected: boolean; io: { engine: { close(): void } } };
      canonicalPendingDeliveryByLocalId: Map<string, unknown>;
      pendingCustodyOutcomeTimers: Map<string, ReturnType<typeof setTimeout>>;
    };
    const queue = new MessageQueue2<string, UserMessage>(() => 'controlled', { batcher: (messages) => messages[0]! });
    client.onUserMessage((message, info) => queue.push(message, 'controlled', {
      userMessageLocalId: message.localId, userMessageSeq: info?.seq,
      providerAcceptancePending: info?.providerAcceptancePending, pendingProviderAction: info?.pendingProviderAction,
    }));
    const consumer = createSessionProviderInputConsumer({
      messageQueue: queue, session: client,
      pendingQueueDeliveryTiming: 'after_runtime_idle',
    });
    const abort = new AbortController();
    let oldServer: ReturnType<typeof createServer> | undefined;
    let statusInterceptor: number | undefined;
    let oldServerStatusReads = 0;
    const observe = client.bindProviderInputOutcomeProducer({
      providerId: 'codex', mode: 'controlled', matchesCurrentSession: () => true,
    });
    // Freeze only the custody clock. Socket.IO, the server and test deadlines keep real time.
    const realSetTimeout = globalThis.setTimeout;
    const frozenCustodyTimers = new Set<ReturnType<typeof setTimeout>>();
    globalThis.setTimeout = ((callback, delay, ...args) => {
      if (delay === custodyTimeoutMs) {
        const timer = realSetTimeout(() => {}, custodyTimeoutMs);
        frozenCustodyTimers.add(timer);
        return timer;
      }
      return realSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout;
    const enqueue = async (localId: string, requestedAction: 'enqueue' | 'send_now' = 'enqueue') => {
      const result = await fetchJson(`${server.baseUrl}/v2/sessions/${sessionId}/pending`, {
        method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ localId, ciphertext: encodeBase64(encrypt(key, 'legacy', {
          role: 'user', content: { type: 'text', text: `prompt ${localId}` }, localId,
        })), requestedAction: { v: 1, kind: requestedAction } }),
      });
      assert.equal(result.status, 200);
    };
    const take = async () => {
      await waitFor(async () => {
        await client.reconcilePendingQueueState({ force: true });
        const result = await consumer.drainPending({ abortSignal: abort.signal });
        return result.materialized === 1;
      }, { timeoutMs: 10_000, context: 'later input materializes before the frozen A custody expiry' });
      const batch = await consumer.waitForNextInput({ abortSignal: abort.signal });
      assert.notEqual(batch, null);
      await consumer.runProviderInputDispatch({ abortSignal: abort.signal, dispatch: async () => {} });
      return batch!;
    };

    try {
      await activity.bindPublisher(client.getRuntimeActivitySnapshotPublisher());
      await waitFor(() => state.socket.connected && client.readRuntimeActivitySnapshotTail().settlement !== null,
        { timeoutMs: 30_000, context: 'real client publisher registration' });
      await enqueue('A', 'send_now');
      const a = await take();
      assert.deepEqual(a.userMessageLocalIds, ['A']);
      assert.equal(state.canonicalPendingDeliveryByLocalId.has('A'), true);
      assert.equal(state.pendingCustodyOutcomeTimers.has('A'), true);
      if (collision) {
        const reserved = `send-as-new-${createHash('sha256')
          .update(`happier.pending.send-as-new.v1\0${sessionId}\0A`).digest('hex')}`;
        await enqueue(reserved);
        assert.equal((await fetchJson(`${server.baseUrl}/v2/sessions/${sessionId}/pending/${reserved}/discard`, {
          method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'manual' }),
        })).status, 200);
      }
      await enqueue('C');
      const priorEpoch = state.sessionConnectionEpoch;
      state.socket.io.engine.close();
      await waitFor(async () => {
        const pending = await listPendingQueueV2({ baseUrl: server.baseUrl, token: auth.token, sessionId });
        return state.sessionConnectionEpoch > priorEpoch && state.socket.connected
          && client.readRuntimeActivitySnapshotTail().custody === null
          && pending.data.pending?.some((row) => row.localId.startsWith('send-as-new-')) === true;
      }, { timeoutMs: 30_000, context: 'same real client successor registration re-offers A' });

      if (scenario === 'absence') {
        // Remove only this fixture's already-discarded A. Its queued replacement and counters stay intact.
        const sqlite = new DatabaseSync(join(process.argv[5]!, 'happier-server-light.sqlite'));
        try {
          const removed = sqlite.prepare('DELETE FROM SessionPendingMessage WHERE sessionId = ? AND localId = ? AND status = ? AND discardedReason = ?')
            .run(sessionId, 'A', 'discarded', 'resent_as_new');
          assert.equal(removed.changes, 1);
        } finally { sqlite.close(); }
        const absent = await fetchJson(`${server.baseUrl}/v2/sessions/${sessionId}/pending/A/status`, {
          headers: { Authorization: `Bearer ${auth.token}` },
        });
        assert.equal(absent.status, 404);
      }
      if (scenario === 'old-server') {
        // Reproduce the HTTP boundary of a server without the new route; every other operation remains real.
        oldServer = createServer((_request, response) => { oldServerStatusReads += 1; response.writeHead(404); response.end(); });
        await new Promise<void>((resolve) => oldServer!.listen(0, '127.0.0.1', resolve));
        const address = oldServer.address();
        assert.ok(address && typeof address !== 'string');
        statusInterceptor = axios.interceptors.request.use((config) => {
          if (config.url === `${server.baseUrl}/v2/sessions/${sessionId}/pending/A/status`) {
            config.url = `http://127.0.0.1:${address.port}/v2/sessions/${sessionId}/pending/A/status`;
          }
          return config;
        });
      }
      if (scenario === 'absence' || scenario === 'old-server') {
        await client.reconcilePendingQueueState({ force: true });
        const result = await consumer.drainPending({ abortSignal: abort.signal });
        assert.equal(result.materialized, 0);
        if (scenario === 'old-server') assert.ok(oldServerStatusReads > 0);
        assert.equal(state.canonicalPendingDeliveryByLocalId.has('A'), true);
        assert.equal(state.pendingCustodyOutcomeTimers.has('A'), true);
        assert.equal(client.getCommittedUserMessageSeq('A'), null);
        assert.equal(queue.size(), 0);
        assert.equal((await fetchAllMessages(server.baseUrl, auth.token, sessionId)).some((row) => row.localId === 'A'), false);
        return;
      }
      // This is RED before the exact-status fix: the actual pending lookup hides A and custody holds C.
      const c = await take();
      assert.deepEqual(c.userMessageLocalIds, ['C']);
      assert.equal(state.canonicalPendingDeliveryByLocalId.has('A'), true);
      assert.equal(state.pendingCustodyOutcomeTimers.has('A'), false);
      observe({ kind: 'accepted', localId: 'C' });
      await waitFor(() => client.getCommittedUserMessageSeq('C') !== null, { timeoutMs: 20_000 });
      const before = await listPendingQueueV2({ baseUrl: server.baseUrl, token: auth.token, sessionId });
      const replacement = before.data.pending!.find((row) => row.localId.startsWith('send-as-new-'))!;
      assert.ok(replacement);
      assert.deepEqual((replacement as typeof replacement & { requestedAction: unknown }).requestedAction, { v: 1, kind: 'enqueue' });
      if (collision) assert.notEqual(replacement.localId, `send-as-new-${createHash('sha256')
        .update(`happier.pending.send-as-new.v1\0${sessionId}\0A`).digest('hex')}`);
      const countBefore = (await fetchSessionV2(server.baseUrl, auth.token, sessionId)).pendingCount;
      observe({ kind: 'accepted', localId: 'A' });
      await waitFor(async () => (await fetchAllMessages(server.baseUrl, auth.token, sessionId))
        .some((row) => row.localId === 'A'), { timeoutMs: 20_000, context: 'exact late A acceptance commits on server' });
      await waitFor(() => !state.canonicalPendingDeliveryByLocalId.has('A'), { timeoutMs: 20_000 });
      assert.notEqual(client.getCommittedUserMessageSeq('A'), null);
      assert.equal((await fetchSessionV2(server.baseUrl, auth.token, sessionId)).pendingCount, countBefore);
      const b = await take();
      assert.deepEqual(b.userMessageLocalIds, [replacement.localId]);
      assert.equal(b.pendingProviderAction, 'send');
      const exactStatus = await fetchJson<{ deliveryStatus: unknown }>(
        `${server.baseUrl}/v2/sessions/${sessionId}/pending/${replacement.localId}/status`,
        { headers: { Authorization: `Bearer ${auth.token}` } },
      );
      assert.equal((exactStatus.data.deliveryStatus as { status: string }).status, 'delivering');
      observe({ kind: 'accepted', localId: replacement.localId });
      await waitFor(() => client.getCommittedUserMessageSeq(replacement.localId) !== null, { timeoutMs: 20_000 });
    } finally {
      if (statusInterceptor !== undefined) axios.interceptors.request.eject(statusInterceptor);
      if (oldServer) await new Promise<void>((resolve, reject) => oldServer!.close((error) => error ? reject(error) : resolve()));
      abort.abort();
      await consumer.closeProviderInputAdmissionAndWaitForDispatches();
      await client.close();
      await activity.dispose();
      binding.socket.close();
      globalThis.setTimeout = realSetTimeout;
      for (const timer of frozenCustodyTimers) clearTimeout(timer);
    }
}

main().then(() => { process.exitCode = 0; }, (error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
