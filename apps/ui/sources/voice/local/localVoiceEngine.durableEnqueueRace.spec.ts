import { createRequire, Module } from 'node:module';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import {
  __emitSpeechRecognitionEvent,
  __resetExpoSpeechRecognitionStub,
  __setExpoSpeechRecognitionImpls,
} from '@/dev/expoSpeechRecognitionStub';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storageStore';
import { Encryption } from '@/sync/encryption/encryption';
import { sync } from '@/sync/sync';
import { voiceSessionBindingStore } from '@/voice/sessionBinding/voiceSessionBindingStore';
import { patchLocalVoiceState } from './localVoiceState';

// Real engine, real sendVoiceTextTurn, real durable Pending owner, real local state and adapter snapshot.
// Only HTTP acknowledgements, credentials, capability fetch and native speech/microphone are substituted.
vi.mock('@/utils/platform/microphonePermissions', () => ({
  requestMicrophonePermission: vi.fn(async () => ({ granted: true, canAskAgain: true })),
  showMicrophonePermissionDeniedAlert: vi.fn(),
}));
const speech = vi.hoisted(() => vi.fn<(text: string, options?: { onDone?: () => void }) => void>());
vi.mock('expo-speech', () => ({ speak: speech, stop: vi.fn() }));

const accountId = 'voice-enqueue-race-account';
const controlSessionId = 'voice-global';
const boundaryEvents: string[] = [];
const pendingRows = new Map<string, { sessionId: string; row: Record<string, unknown> }>();
const handledRows = new Map<string, Record<string, unknown>>();
let pendingVersion = 0;
let pendingGate: Promise<void> | undefined;
const initialStorageState = storage.getState();
const initialBindings = voiceSessionBindingStore.getState().bindingsByConversationSessionId;
const initialEncryption = Reflect.get(sync, 'encryption');
// The native require adapter must return the same real singleton already loaded by Vitest.
const nodeRequire = createRequire(import.meta.url);
const syncModulePath = nodeRequire.resolve('../../sync/sync.ts');
const priorSyncModule = nodeRequire.cache[syncModulePath];
const syncModule = new Module(syncModulePath);
syncModule.exports = { sync };
syncModule.loaded = true;
nodeRequire.cache[syncModulePath] = syncModule;
afterAll(() => {
  if (priorSyncModule) nodeRequire.cache[syncModulePath] = priorSyncModule;
  else delete nodeRequire.cache[syncModulePath];
});

function agentVoiceSettings() {
  return settingsParse({ voice: { providerId: 'local_conversation', adapters: { local_conversation: {
    conversationMode: 'agent', agent: { backend: 'daemon' }, stt: { provider: 'device' },
    tts: { provider: 'device', autoSpeakReplies: false },
  } } } });
}

async function loadEngine() {
  const engine = await import('./localVoiceEngine');
  const { createLocalConversationVoiceAdapter } = await import('../adapters/localConversation/localConversationAdapter');
  return { ...engine, adapter: createLocalConversationVoiceAdapter() };
}

/** Starts an agent-mode voice turn whose durable enqueue acknowledgement is held until `release`. */
async function startTurnWithDelayedEnqueueAck(send: (sessionId: string, text: string) => Promise<void>) {
  let release!: () => void;
  pendingGate = new Promise<void>((resolve) => { release = resolve; });
  const sending = send(controlSessionId, 'delayed acknowledged input');
  await vi.waitFor(() => expect(pendingRows.size).toBe(1));
  return { release, sending };
}

/** Records every local voice state the aborted turn publishes after the newer owner took over. */
function recordLateStatePublications(getState: () => { status: string; sessionId: string | null }, subscribe: (listener: () => void) => () => void) {
  const published: Array<{ status: string; sessionId: string | null }> = [];
  const unsubscribe = subscribe(() => {
    const { status, sessionId } = getState();
    published.push({ status, sessionId });
  });
  return { published, unsubscribe };
}

function expectRowRetainedAsUncertain() {
  const row = [...pendingRows.values()][0]?.row;
  expect(handledRows.size).toBe(0);
  expect(row?.deliveryStatus).toEqual({ status: 'blocked', reason: 'delivery_outcome_uncertain' });
  expect(boundaryEvents).toEqual([`enqueue:${row?.localId}`, `blocked:${row?.localId}`]);
}

describe('local voice engine: interaction ownership across a delayed durable enqueue acknowledgement', () => {
  beforeEach(async () => {
    storage.setState(initialStorageState, true);
    storage.getState().activateProfileScope({ serverId: getActiveServerSnapshot().serverId, accountId });
    const now = Date.now();
    storage.setState({ sessions: Object.fromEntries(['s1', 'carrier-s1'].map(id => [id, createSessionFixture({
      id, active: true, activeAt: now, encryptionMode: 'e2ee', pendingCount: 0, pendingVersion: 0,
    })])) });
    const encryption = await Encryption.create(new Uint8Array(32).fill(7));
    await encryption.initializeSessions(new Map([['s1', null], ['carrier-s1', null]]));
    Reflect.set(sync, 'encryption', encryption);
    const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token, secret: '' });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      features: { voice: { enabled: true },
        sharing: { pendingQueueV2: { enabled: true }, pendingDeliveryState: { enabled: true } } },
      capabilities: { compatibility: { pendingInput: { currentPendingInputProtocolVersion: 1 } },
        session: { pendingInput: { protocolVersion: 1 } } },
    })));
    pendingGate = undefined;
    pendingRows.clear();
    handledRows.clear();
    pendingVersion = 0;
    boundaryEvents.length = 0;
    // HTTP acknowledgements are the boundary; durable custody stays real.
    vi.spyOn(apiSocket, 'request').mockImplementation(async (path, init) => {
      if (/^\/v[12]\/sessions\/[^/]+\/messages(?:\?|$)/.test(path)) {
        return Response.json({ messages: [], hasMore: false });
      }
      const route = /^\/v2\/sessions\/([^/]+)\/pending(?:\/([^/]+)\/delivery\/(block|handled))?$/.exec(new URL(path, 'http://relay.test').pathname);
      if (!route) throw new Error(`Unexpected pending route: ${path}`);
      const sessionId = route[1]!;
      if (route[2]) {
        const pending = pendingRows.get(route[2]);
        if (!pending) throw new Error('Unknown pending localId');
        if (route[3] === 'handled') {
          boundaryEvents.push(`handled:${route[2]}`);
          handledRows.set(route[2], pending.row);
          pendingRows.delete(route[2]);
        } else {
          boundaryEvents.push(`blocked:${route[2]}`);
          pending.row.deliveryStatus = { status: 'blocked', reason: 'delivery_outcome_uncertain' };
        }
        pendingVersion += 1;
        return Response.json({ ok: true });
      }
      if (init?.method === 'GET') {
        return Response.json({ pending: [...pendingRows.values()].filter(value => value.sessionId === sessionId).map(value => value.row),
          pendingCount: pendingRows.size, pendingVersion });
      }
      const body = JSON.parse(String(init?.body)) as { localId: string; content?: unknown; ciphertext?: string; deliveryMode?: string; requestedAction: unknown };
      boundaryEvents.push(`enqueue:${body.localId}`);
      const row = { localId: body.localId, content: body.content ?? { t: 'encrypted', c: body.ciphertext }, status: 'queued', position: pendingRows.size,
        createdAt: 1, updatedAt: 1, discardedAt: null, discardedReason: null, authorAccountId: accountId,
        requestedAction: body.requestedAction, messageRole: 'user',
        deliveryStatus: { status: body.deliveryMode === 'external_handoff' ? 'external_handoff' : 'queued' } };
      pendingRows.set(body.localId, { sessionId, row });
      pendingVersion += 1;
      if (pendingGate) await pendingGate;
      return Response.json({ didWrite: true, requestedAction: body.requestedAction, pending: row,
        pendingCount: pendingRows.size, pendingVersion });
    });
    voiceSessionBindingStore.setState({ bindingsByConversationSessionId: initialBindings });
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation', controlSessionId, conversationSessionId: 'carrier-s1',
      transcriptMode: 'synthetic', targetSessionId: 's1', updatedAt: 1,
    });
    storage.setState({ settings: agentVoiceSettings() });
    __resetExpoSpeechRecognitionStub();
    // Native recognizer stop reports its end so a hang-up does not wait on the recognizer timeout.
    __setExpoSpeechRecognitionImpls({ stop: () => __emitSpeechRecognitionEvent('end') });
    speech.mockReset().mockImplementation((_text, options) => options?.onDone?.());
    // An active call on the voice control session, ready for its next turn.
    patchLocalVoiceState({ status: 'idle', sessionId: controlSessionId, error: null });
  });

  afterEach(async () => {
    const { stopLocalVoiceSession } = await import('./localVoiceEngine');
    await stopLocalVoiceSession();
    patchLocalVoiceState({ status: 'idle', sessionId: null, error: null });
    __resetExpoSpeechRecognitionStub();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.set(sync, 'encryption', initialEncryption);
    storage.setState(initialStorageState, true);
    voiceSessionBindingStore.setState({ bindingsByConversationSessionId: initialBindings });
  });

  it('keeps a completed hang-up disconnected when the turn acknowledgement arrives afterwards', async () => {
    const { sendLocalVoiceAgentTextUpdate, stopLocalVoiceSession, getLocalVoiceState, subscribeLocalVoiceState, adapter } = await loadEngine();
    const { release, sending } = await startTurnWithDelayedEnqueueAck(sendLocalVoiceAgentTextUpdate);
    let late: ReturnType<typeof recordLateStatePublications> | undefined;
    try {
      await stopLocalVoiceSession();
      expect(getLocalVoiceState()).toMatchObject({ status: 'idle', sessionId: null, error: null });
      late = recordLateStatePublications(getLocalVoiceState, subscribeLocalVoiceState);
    } finally {
      release();
      await sending;
      late?.unsubscribe();
    }

    expect(late?.published).toEqual([]);

    expect(getLocalVoiceState()).toMatchObject({ status: 'idle', sessionId: null, error: null });
    expect(adapter.getSnapshot()).toMatchObject({ status: 'disconnected', mode: 'idle', canStop: false, sessionId: null });
    expectRowRetainedAsUncertain();
  });

  it('keeps a cancelled turn idle on the active call when the turn acknowledgement arrives afterwards', async () => {
    const { sendLocalVoiceAgentTextUpdate, abortLocalVoiceTurn, getLocalVoiceState, subscribeLocalVoiceState, adapter } = await loadEngine();
    const { release, sending } = await startTurnWithDelayedEnqueueAck(sendLocalVoiceAgentTextUpdate);
    let late: ReturnType<typeof recordLateStatePublications> | undefined;
    try {
      await abortLocalVoiceTurn(controlSessionId);
      expect(getLocalVoiceState()).toMatchObject({ status: 'idle', sessionId: controlSessionId, error: null });
      late = recordLateStatePublications(getLocalVoiceState, subscribeLocalVoiceState);
    } finally {
      release();
      await sending;
      late?.unsubscribe();
    }

    // Not even a transient 'sending' (adapter 'thinking') flash from the cancelled turn.
    expect(late?.published).toEqual([]);

    expect(getLocalVoiceState()).toMatchObject({ status: 'idle', sessionId: controlSessionId, error: null });
    expect(adapter.getSnapshot()).toMatchObject({ status: 'connected', mode: 'idle', sessionId: controlSessionId });
    expect(adapter.getSnapshot().mode).not.toBe('thinking');
    expectRowRetainedAsUncertain();
  });

  it('does not let a cancelled turn acknowledgement overwrite the successor interaction it races with', async () => {
    const { sendLocalVoiceAgentTextUpdate, abortLocalVoiceTurn, toggleLocalVoiceTurn, getLocalVoiceState, subscribeLocalVoiceState, adapter } = await loadEngine();
    const { release, sending } = await startTurnWithDelayedEnqueueAck(sendLocalVoiceAgentTextUpdate);
    let late: ReturnType<typeof recordLateStatePublications> | undefined;
    try {
      await abortLocalVoiceTurn(controlSessionId);
      // The user immediately starts speaking again on the same call.
      await toggleLocalVoiceTurn(controlSessionId);
      expect(getLocalVoiceState()).toMatchObject({ status: 'recording', sessionId: controlSessionId, error: null });
      late = recordLateStatePublications(getLocalVoiceState, subscribeLocalVoiceState);
    } finally {
      release();
      await sending;
      late?.unsubscribe();
    }

    expect(late?.published).toEqual([]);

    expect(getLocalVoiceState()).toMatchObject({ status: 'recording', sessionId: controlSessionId, error: null });
    expect(adapter.getSnapshot()).toMatchObject({ status: 'connected', mode: 'listening', sessionId: controlSessionId });
    expectRowRetainedAsUncertain();
  });
});
