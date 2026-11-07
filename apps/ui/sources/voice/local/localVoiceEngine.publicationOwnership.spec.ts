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

describe('local voice engine: call-state publication belongs to the current engine run', () => {
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

  function enableAutoSpeak(streaming?: { ttsChunkChars: number }) {
    const settings: any = agentVoiceSettings();
    const config = settings.voice.adapters.local_conversation;
    config.tts.autoSpeakReplies = true;
    if (streaming) config.streaming = { enabled: true, ttsEnabled: true, ttsChunkChars: streaming.ttsChunkChars };
    storage.setState({ settings });
  }

  /** An agent stream that emits several speech chunks of text, then fails (a supported reader sequence). */
  async function failingStreamAfterDeltas(sessionId: string, text: string, opts: unknown) {
    const { streamVoiceAgentTurn } = await import('../agent/streamVoiceAgentTurn');
    return streamVoiceAgentTurn({ sessionId, userText: text, displayUserText: text, options: opts as any, handle: {
      backend: 'daemon', rpcSessionId: 'carrier-s1', voiceAgentId: 'failing-stream', client: {
        startTurnStream: async () => ({ streamId: 'failing-stream' }),
        readTurnStream: async () => ({ streamId: 'failing-stream', events: [
          { t: 'delta', textDelta: 'First sentence has many words to speak. Second sentence has more words to speak. Third sentence has yet more words. ' },
          { t: 'error', error: 'provider stream failed after deltas' },
        ], nextCursor: 2, done: true }),
        cancelTurnStream: async () => {},
      } } as any });
  }

  it('retires a completed run: queued speech of a stream that failed after deltas cannot mark the successor speaking', async () => {
    const { sendLocalVoiceAgentTextUpdate: send, abortLocalVoiceTurn, getLocalVoiceState, subscribeLocalVoiceState, adapter } = await loadEngine();
    const { voiceAgentSessions } = await import('../agent/voiceAgentSessions');
    enableAutoSpeak({ ttsChunkChars: 32 });
    let resolveNext!: (r: { assistantText: string; actions: never[] }) => void;
    const nextResponse = new Promise<{ assistantText: string; actions: never[] }>((r) => { resolveNext = r; });
    let oldSignal: AbortSignal | undefined;
    const provider = vi.spyOn(voiceAgentSessions, 'sendInterruptingTextUpdate')
      .mockImplementationOnce(async (id, text, opts) => { oldSignal = opts?.signal; return failingStreamAfterDeltas(id, text, opts); })
      .mockImplementationOnce(async () => nextResponse);
    let firstChunk: { onDone?: () => void } | undefined;
    speech.mockImplementation((_text, options) => { if (!firstChunk) firstChunk = options; else options?.onDone?.(); });

    const old = send(controlSessionId, 'streamed input');
    await vi.waitFor(() => expect(firstChunk?.onDone).toBeTypeOf('function'));
    await old;
    // The failed provider handoff keeps its honest uncertain custody; the run completed without abort.
    expectRowRetainedAsUncertain();
    expect(oldSignal?.aborted).toBe(false);

    const next = send(controlSessionId, 'successor input');
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(2));
    expect(getLocalVoiceState()).toMatchObject({ status: 'sending', sessionId: controlSessionId, error: null });
    const late = recordLateStatePublications(getLocalVoiceState, subscribeLocalVoiceState);
    firstChunk!.onDone!();
    await vi.waitFor(() => expect(speech.mock.calls.length).toBeGreaterThan(1));
    late.unsubscribe();
    expect(late.published).toEqual([]);
    expect(getLocalVoiceState()).toMatchObject({ status: 'sending', sessionId: controlSessionId, error: null });
    expect(adapter.getSnapshot()).toMatchObject({ status: 'connected', mode: 'thinking' });

    await abortLocalVoiceTurn(controlSessionId);
    resolveNext({ assistantText: '', actions: [] });
    await next;
  });

  it('keeps the failed stream turn error visible when its queued speech completes after the run ended', async () => {
    const { sendLocalVoiceAgentTextUpdate: send, getLocalVoiceState, subscribeLocalVoiceState } = await loadEngine();
    const { voiceAgentSessions } = await import('../agent/voiceAgentSessions');
    enableAutoSpeak({ ttsChunkChars: 32 });
    vi.spyOn(voiceAgentSessions, 'sendInterruptingTextUpdate').mockImplementationOnce(async (id, text, opts) => failingStreamAfterDeltas(id, text, opts));
    let firstChunk: { onDone?: () => void } | undefined;
    speech.mockImplementation((_text, options) => { if (!firstChunk) firstChunk = options; else options?.onDone?.(); });

    await send(controlSessionId, 'streamed input');
    await vi.waitFor(() => expect(firstChunk?.onDone).toBeTypeOf('function'));
    const failed = { ...getLocalVoiceState() };
    expect(failed).toMatchObject({ status: 'idle', sessionId: controlSessionId });
    expect(failed.error).toBeTruthy();
    const late = recordLateStatePublications(getLocalVoiceState, subscribeLocalVoiceState);
    firstChunk!.onDone!();
    await vi.waitFor(() => expect(speech.mock.calls.length).toBeGreaterThan(1));
    late.unsubscribe();
    // No orphaned `speaking` without an owner left to return the call to idle.
    expect(late.published).toEqual([]);
    expect(getLocalVoiceState()).toEqual(failed);
    expectRowRetainedAsUncertain();
  });

  it.each(['hangup', 'cancel'] as const)('gives the signal-less composer text turn no call-state publication right (%s during its delayed acknowledgement)', async (action) => {
    const { stopLocalVoiceSession, abortLocalVoiceTurn, getLocalVoiceState, subscribeLocalVoiceState, adapter } = await loadEngine();
    const { sendVoiceSessionComposerText } = await import('../sessionBinding/sendVoiceSessionComposerText');
    const { voiceAgentSessions } = await import('../agent/voiceAgentSessions');
    const provider = vi.spyOn(voiceAgentSessions, 'sendTurn').mockResolvedValue({ assistantText: 'Accepted.', actions: [] });
    let release!: () => void;
    pendingGate = new Promise<void>((r) => { release = r; });
    const sending = sendVoiceSessionComposerText({ conversationSessionId: 'carrier-s1', text: 'composer request', getAdapter: () => adapter });
    await vi.waitFor(() => expect(pendingRows.size).toBe(1));
    if (action === 'hangup') await stopLocalVoiceSession();
    else await abortLocalVoiceTurn(controlSessionId);
    const before = { ...getLocalVoiceState() };
    const late = recordLateStatePublications(getLocalVoiceState, subscribeLocalVoiceState);
    release();
    const result = await sending;
    late.unsubscribe();
    // The independent durable text operation still completes its handoff…
    expect(provider).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, disposition: 'handoff_acknowledged' });
    // …but it never reconnects or rewrites the call.
    expect(late.published).toEqual([]);
    expect(getLocalVoiceState()).toEqual(before);
    if (action === 'hangup') {
      expect(before).toMatchObject({ status: 'idle', sessionId: null, error: null });
      expect(adapter.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
    } else {
      expect(before).toMatchObject({ status: 'idle', sessionId: controlSessionId, error: null });
    }
  });

  it('drops a late native TTS error of a superseded turn instead of reporting it on the successor', async () => {
    const { sendLocalVoiceAgentTextUpdate: send, abortLocalVoiceTurn, getLocalVoiceState, subscribeLocalVoiceState } = await loadEngine();
    const { voiceAgentSessions } = await import('../agent/voiceAgentSessions');
    enableAutoSpeak();
    let resolveNext!: (r: { assistantText: string; actions: never[] }) => void;
    const nextResponse = new Promise<{ assistantText: string; actions: never[] }>((r) => { resolveNext = r; });
    const provider = vi.spyOn(voiceAgentSessions, 'sendInterruptingTextUpdate')
      .mockResolvedValueOnce({ assistantText: 'Old spoken reply.', actions: [] })
      .mockImplementationOnce(async () => nextResponse);
    let oldSpeech: { onError?: (error: Error) => void } | undefined;
    speech.mockImplementation((_text, options) => { oldSpeech = options as typeof oldSpeech; });

    const old = send(controlSessionId, 'old input');
    await vi.waitFor(() => expect(oldSpeech?.onError).toBeTypeOf('function'));
    expect(getLocalVoiceState().status).toBe('speaking');
    const next = send(controlSessionId, 'successor input');
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(2));
    expect(provider.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    const late = recordLateStatePublications(getLocalVoiceState, subscribeLocalVoiceState);
    oldSpeech!.onError!(new Error('old native provider failed'));
    await old;
    late.unsubscribe();
    expect(late.published).toEqual([]);
    expect(getLocalVoiceState()).toMatchObject({ status: 'sending', sessionId: controlSessionId, error: null, errorMessage: null });

    await abortLocalVoiceTurn(controlSessionId);
    resolveNext({ assistantText: '', actions: [] });
    await next;
  });

  it('still reports a native TTS failure of the active turn', async () => {
    const { sendLocalVoiceAgentTextUpdate: send, getLocalVoiceState, adapter } = await loadEngine();
    const { voiceAgentSessions } = await import('../agent/voiceAgentSessions');
    enableAutoSpeak();
    vi.spyOn(voiceAgentSessions, 'sendInterruptingTextUpdate').mockResolvedValueOnce({ assistantText: 'Spoken reply.', actions: [] });
    speech.mockImplementation((_text, options) => (options as { onError?: (error: Error) => void })?.onError?.(new Error('synthesis-failed')));

    await send(controlSessionId, 'input');
    expect(getLocalVoiceState()).toMatchObject({ status: 'idle', sessionId: controlSessionId, error: 'tts_failed', errorMessage: 'synthesis-failed' });
    expect(adapter.getSnapshot()).toMatchObject({ errorCode: 'tts_failed', errorMessage: 'synthesis-failed' });
  });

  it('does not report a deliberate stop of the active turn speech as a TTS failure', async () => {
    const { sendLocalVoiceAgentTextUpdate: send, abortLocalVoiceTurn, getLocalVoiceState } = await loadEngine();
    const { voiceAgentSessions } = await import('../agent/voiceAgentSessions');
    const expoSpeech = await import('expo-speech');
    enableAutoSpeak();
    vi.spyOn(voiceAgentSessions, 'sendInterruptingTextUpdate').mockResolvedValueOnce({ assistantText: 'Spoken reply.', actions: [] });
    let activeSpeech: { onError?: (error: Error) => void } | undefined;
    speech.mockImplementation((_text, options) => { activeSpeech = options as typeof activeSpeech; });
    // Browsers report speechSynthesis.cancel() as an utterance error.
    vi.mocked(expoSpeech.stop).mockImplementation(async () => { activeSpeech?.onError?.(new Error('interrupted')); });

    const sending = send(controlSessionId, 'input');
    await vi.waitFor(() => expect(getLocalVoiceState().status).toBe('speaking'));
    await abortLocalVoiceTurn(controlSessionId);
    await sending;
    expect(getLocalVoiceState()).toMatchObject({ status: 'idle', sessionId: controlSessionId, error: null, errorMessage: null });
    vi.mocked(expoSpeech.stop).mockReset();
  });
});
