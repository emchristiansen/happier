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
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { voiceSessionBindingStore } from '@/voice/sessionBinding/voiceSessionBindingStore';
import { patchLocalVoiceState } from './localVoiceState';

// Connect-time welcome ownership (UI-VOICE-06), from the R10 reviewer's probes (t_17927351 review-voice).
// Real engine, real sendVoiceTextTurn, real durable Pending owner, real local state and adapter snapshot.
// Only HTTP acknowledgements, credentials, capability fetch and native speech/microphone are substituted.
vi.mock('@/utils/platform/microphonePermissions', () => ({
  requestMicrophonePermission: vi.fn(async () => ({ granted: true, canAskAgain: true })),
  showMicrophonePermissionDeniedAlert: vi.fn(),
}));
const speech = vi.hoisted(() => vi.fn<(text: string, options?: { onDone?: () => void }) => void>());
const speechStop = vi.hoisted(() => vi.fn());
vi.mock('expo-speech', () => ({ speak: speech, stop: speechStop }));

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

describe('local voice engine: connect-time welcome ownership', () => {
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
    speechStop.mockReset();
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

  function configureHttpAgent(autoSpeak = true) {
    const settings:any = agentVoiceSettings();
    const config=settings.voice.adapters.local_conversation;
    config.agent.backend='openai_compat';
    config.agent.prewarmOnConnect=false;
    config.agent.openaiCompat.chatBaseUrl='https://voice-agent.test/v1';
    config.tts.autoSpeakReplies=autoSpeak;
    config.streaming.enabled=false;
    storage.setState({settings});
    return settings;
  }

  it('an immediate welcome failure cannot publish on a successor engine turn', async()=>{
    const settings=configureHttpAgent();
    settings.voice.adapters.local_conversation.agent.prewarmOnConnect=true;
    settings.voice.adapters.local_conversation.agent.welcome={enabled:true,mode:'immediate',templateId:null};
    storage.setState({settings});
    const {toggleLocalVoiceTurn,sendLocalVoiceAgentTextUpdate:send,getLocalVoiceState,subscribeLocalVoiceState,abortLocalVoiceTurn,adapter}=await loadEngine();
    let nativeOptions:any;
    speech.mockImplementation((_text,opts)=>{nativeOptions=opts;});
    // Real session controller and OpenAI-compatible welcome implementation; no mocked welcome method.
    await toggleLocalVoiceTurn(controlSessionId);
    await vi.waitFor(()=>expect(nativeOptions?.onError).toBeTypeOf('function'));
    expect(speech.mock.calls[0]?.[0]).toBe('Hey! What are we working on today?');
    expect(getLocalVoiceState().status).toBe('recording');
    const featureFetch=globalThis.fetch;
    let providerRequests=0;
    let resolveNext!:(r:Response)=>void;
    const response=new Promise<Response>(r=>{resolveNext=r;});
    vi.stubGlobal('fetch',vi.fn(async(input,init)=>{
      if(String(input)==='https://voice-agent.test/v1/chat/completions'){providerRequests++;return response;}
      return featureFetch(input,init);
    }));
    const next=send(controlSessionId,'successor input');
    await vi.waitFor(()=>expect(providerRequests).toBe(1));
    expect(getLocalVoiceState()).toMatchObject({status:'sending',error:null});
    const late=recordLateStatePublications(getLocalVoiceState,subscribeLocalVoiceState);
    nativeOptions.onError(new Error('predecessor welcome failed'));
    // Join callback propagation without substituting the state writer.
    for(let i=0;i<30;i++) await Promise.resolve();
    const observed={...getLocalVoiceState()};
    late.unsubscribe();
    // Always settle our pending real-client request before asserting the negative.
    await abortLocalVoiceTurn(controlSessionId);
    resolveNext(Response.json({choices:[{message:{content:''}}]}));
    await next;
    expect(observed).toMatchObject({status:'sending',sessionId:controlSessionId,error:null,errorMessage:null});
    expect(late.published).toEqual([]);
  });

  it('an active immediate welcome failure is still visible',async()=>{
    const settings=configureHttpAgent();
    settings.voice.adapters.local_conversation.agent.prewarmOnConnect=true;
    settings.voice.adapters.local_conversation.agent.welcome={enabled:true,mode:'immediate',templateId:null};
    storage.setState({settings});
    const {toggleLocalVoiceTurn,getLocalVoiceState,adapter}=await loadEngine();
    let nativeOptions:any;
    speech.mockImplementation((_text,opts)=>{nativeOptions=opts;});
    await toggleLocalVoiceTurn(controlSessionId);
    await vi.waitFor(()=>expect(nativeOptions?.onError).toBeTypeOf('function'));
    nativeOptions.onError(new Error('active welcome failed'));
    await vi.waitFor(()=>expect(getLocalVoiceState().error).toBe('tts_failed'));
    expect(getLocalVoiceState()).toMatchObject({status:'recording',sessionId:controlSessionId,error:'tts_failed',errorMessage:'active welcome failed'});
    expect(adapter.getSnapshot()).toMatchObject({mode:'listening',errorCode:'tts_failed'});
  });

  it('a completed hang-up suppresses the native error of a stopped welcome',async()=>{
    const settings=configureHttpAgent();
    settings.voice.adapters.local_conversation.agent.prewarmOnConnect=true;
    settings.voice.adapters.local_conversation.agent.welcome={enabled:true,mode:'immediate',templateId:null};
    storage.setState({settings});
    const {toggleLocalVoiceTurn,stopLocalVoiceSession,getLocalVoiceState,subscribeLocalVoiceState}=await loadEngine();
    let nativeOptions:any;
    speech.mockImplementation((_text,opts)=>{nativeOptions=opts;});
    await toggleLocalVoiceTurn(controlSessionId);
    await vi.waitFor(()=>expect(nativeOptions?.onError).toBeTypeOf('function'));
    await stopLocalVoiceSession();
    const late=recordLateStatePublications(getLocalVoiceState,subscribeLocalVoiceState);
    nativeOptions.onError(new Error('stopped welcome failed'));
    for(let i=0;i<30;i++) await Promise.resolve();
    late.unsubscribe();
    expect(getLocalVoiceState()).toMatchObject({status:'idle',sessionId:null,error:null});
    expect(late.published).toEqual([]);
  });

  it('a daemon welcome delivered after a completed hang-up neither speaks nor publishes', async()=>{
    const settings:any=agentVoiceSettings();
    settings.experiments=true;
    settings.featureToggles={voice:true,'execution.runs':true,'voice.agent':true};
    const config=settings.voice.adapters.local_conversation;
    config.agent.prewarmOnConnect=true;
    config.agent.welcome={enabled:true,mode:'immediate',templateId:null};
    config.tts.autoSpeakReplies=true;
    storage.setState({settings,sessions:{...storage.getState().sessions,s1:{...storage.getState().sessions.s1!,presence:'online'}}});
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({features:{voice:{enabled:true},execution:{runs:{enabled:true}},sharing:{pendingQueueV2:{enabled:true},pendingDeliveryState:{enabled:true}}},capabilities:{}})));
    let resolveWelcome!:(x:any)=>void;
    const welcomeResponse=new Promise<any>(r=>{resolveWelcome=r;});
    const rpcEvents:Array<{method:string;payload:any}>=[];
    const {SESSION_RPC_METHODS}=await import('@happier-dev/protocol/rpc');
    vi.spyOn(apiSocket,'sessionRPC').mockImplementation(async(_id,method,payload)=>{
      rpcEvents.push({method,payload});
      if(method===SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START) return {ok:true,runId:'welcome-run',created:true};
      if(method===SESSION_RPC_METHODS.EXECUTION_RUN_ACTION) return welcomeResponse;
      if(method===SESSION_RPC_METHODS.EXECUTION_RUN_STOP) return {ok:true};
      if(method===SESSION_RPC_METHODS.EXECUTION_RUN_LIST) return {runs:[]};
      if(method===SESSION_RPC_METHODS.EXECUTION_RUN_GET) return {run:null};
      throw new Error('Unexpected RPC '+method);
    });
    const {toggleLocalVoiceTurn,stopLocalVoiceSession,getLocalVoiceState,subscribeLocalVoiceState,adapter}=await loadEngine();
    let nativeOptions:any;
    speech.mockImplementation((_text,opts)=>{nativeOptions=opts;});
    await toggleLocalVoiceTurn('s1');
    await vi.waitFor(()=>expect(rpcEvents.some(x=>x.method===SESSION_RPC_METHODS.EXECUTION_RUN_ACTION)).toBe(true));
    expect(getLocalVoiceState()).toMatchObject({status:'recording',sessionId:'s1'});
    await stopLocalVoiceSession();
    expect(getLocalVoiceState()).toMatchObject({status:'idle',sessionId:null,error:null});
    expect(rpcEvents.some(x=>x.method===SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toBe(true);
    const late=recordLateStatePublications(getLocalVoiceState,subscribeLocalVoiceState);
    resolveWelcome({ok:true,result:{assistantText:'Welcome from ended call.'}});
    for(let i=0;i<30;i++) await Promise.resolve();
    // An ended call's welcome has no authority to start speech; were it started, its failure must
    // not reach the ended call either.
    expect(speech).not.toHaveBeenCalled();
    nativeOptions?.onError?.(new Error('ended call welcome failed'));
    for(let i=0;i<30;i++) await Promise.resolve();
    late.unsubscribe();
    expect(getLocalVoiceState()).toMatchObject({status:'idle',sessionId:null,error:null,errorMessage:null});
    expect(adapter.getSnapshot()).toMatchObject({sessionId:null,status:'disconnected'});
    expect(late.published).toEqual([]);
  });

  // UI-VOICE-07 and UI-VOICE-08, from the R11 reviewer's probes (t_17927351 review-r11-voice, V3).
  let fixtureEpoch = 0;

  async function drain() {
    for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  }

  /** Real daemon client and session controller; only the session RPC transport is substituted. */
  async function daemonWelcomeHarness() {
    const settings: any = agentVoiceSettings();
    settings.experiments = true;
    settings.featureToggles = { voice: true, 'execution.runs': true, 'voice.agent': true };
    const config = settings.voice.adapters.local_conversation;
    // A transcript epoch of its own, so welcome bookkeeping from another case cannot leak in.
    config.agent.transcript.epoch = ++fixtureEpoch;
    config.agent.prewarmOnConnect = true;
    config.agent.welcome = { enabled: true, mode: 'immediate', templateId: null };
    config.tts.autoSpeakReplies = true;
    storage.setState({ settings, sessions: { ...storage.getState().sessions, s1: { ...storage.getState().sessions.s1!, presence: 'online' } } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ features: { voice: { enabled: true }, execution: { runs: { enabled: true } },
      sharing: { pendingQueueV2: { enabled: true }, pendingDeliveryState: { enabled: true } } }, capabilities: {} })));
    const { SESSION_RPC_METHODS: M } = await import('@happier-dev/protocol/rpc');
    const welcomeResponses: Array<(response: any) => void> = [];
    let runStarts = 0;
    vi.spyOn(apiSocket, 'sessionRPC').mockImplementation(async (_id, method) => {
      if (method === M.EXECUTION_RUN_ENSURE_OR_START) return { ok: true, runId: `welcome-run-${++runStarts}`, created: true };
      if (method === M.EXECUTION_RUN_ACTION) return await new Promise<any>((resolve) => welcomeResponses.push(resolve));
      if (method === M.EXECUTION_RUN_STOP) return { ok: true };
      if (method === M.EXECUTION_RUN_LIST) return { runs: [] };
      if (method === M.EXECUTION_RUN_GET) return { run: null };
      throw new Error('Unexpected RPC ' + method);
    });
    return { welcomeResponses, runStarts: () => runStarts };
  }

  it('an ended call\'s late welcome does not mark the next same-epoch call as already welcomed', async()=>{
    const h=await daemonWelcomeHarness();
    const {toggleLocalVoiceTurn,stopLocalVoiceSession}=await loadEngine();
    await toggleLocalVoiceTurn('s1');
    await vi.waitFor(()=>expect(h.welcomeResponses).toHaveLength(1));
    await stopLocalVoiceSession();
    h.welcomeResponses[0]!({ok:true,result:{assistantText:'Ended call welcome'}});
    await drain();
    await toggleLocalVoiceTurn('s1');
    await vi.waitFor(()=>expect(h.runStarts()).toBe(2));
    await drain();
    expect(h.welcomeResponses).toHaveLength(2);
    h.welcomeResponses[1]!({ok:true,result:{assistantText:'New call welcome'}});
    await vi.waitFor(()=>expect(speech).toHaveBeenCalledTimes(1));
    expect(speech.mock.calls.map(x=>x[0])).toEqual(['New call welcome']);
  });

  it('a finished welcome does not suppress the next call\'s welcome', async()=>{
    const h=await daemonWelcomeHarness();
    const {toggleLocalVoiceTurn,stopLocalVoiceSession}=await loadEngine();
    await toggleLocalVoiceTurn('s1');
    await vi.waitFor(()=>expect(h.welcomeResponses).toHaveLength(1));
    h.welcomeResponses[0]!({ok:true,result:{assistantText:'First welcome'}});
    await vi.waitFor(()=>expect(speech).toHaveBeenCalledTimes(1));
    await stopLocalVoiceSession();
    await toggleLocalVoiceTurn('s1');
    await vi.waitFor(()=>expect(h.welcomeResponses).toHaveLength(2));
    h.welcomeResponses[1]!({ok:true,result:{assistantText:'Second welcome'}});
    await vi.waitFor(()=>expect(speech).toHaveBeenCalledTimes(2));
    expect(speech.mock.calls.map(x=>x[0])).toEqual(['First welcome','Second welcome']);
  });

  // UI-VOICE-09, from the R12 reviewer's probe (t_17927351 review-r12-voice, reviewerR12WelcomeGlobalV3). A cancel and
  // rearm on the agent-mode control session keeps the same daemon agent, so only the welcome attempt itself tells a
  // current welcome from a superseded one.
  /** The canonical agent-mode control session bound to its hidden conversation (no machine, so always reusable). */
  function bindAgentControlSession() {
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation', controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID, conversationSessionId: 'carrier-s1',
      transcriptMode: 'synthetic', targetSessionId: 's1', updatedAt: 1,
    });
    const sessions = storage.getState().sessions;
    storage.setState({ sessions: { ...sessions, 'carrier-s1': { ...sessions['carrier-s1']!, presence: 'online',
      metadata: { ...sessions['carrier-s1']!.metadata!, machineId: undefined, systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } } } } });
    patchLocalVoiceState({ status: 'idle', sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, error: null });
    return VOICE_AGENT_GLOBAL_SESSION_ID;
  }

  /** Connects, then cancels and rearms through the real adapter while the first welcome is still in flight. */
  async function rearmDuringWelcome() {
    const h = await daemonWelcomeHarness();
    const id = bindAgentControlSession();
    const e = await loadEngine();
    const rearm = async () => { await e.adapter.interrupt({ sessionId: 's1' }); await e.toggleLocalVoiceTurn(id); };
    await e.toggleLocalVoiceTurn(id);
    await vi.waitFor(() => expect(h.welcomeResponses).toHaveLength(1));
    await rearm();
    await vi.waitFor(() => expect(h.welcomeResponses).toHaveLength(2));
    return { h, rearm };
  }

  it('a superseded welcome on the reused agent cannot suppress a later rearm\'s welcome', async()=>{
    const { h, rearm } = await rearmDuringWelcome();
    h.welcomeResponses[0]!({ok:true,result:{assistantText:'Superseded first welcome'}});
    await drain();
    // A cancel and rearm while the second welcome is in flight makes a third welcome the current one.
    await rearm();
    h.welcomeResponses[1]!({ok:true,result:{assistantText:'Superseded second welcome'}});
    await drain();
    expect(speech).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.welcomeResponses).toHaveLength(3));
    h.welcomeResponses[2]!({ok:true,result:{assistantText:'Current third welcome'}});
    await vi.waitFor(() => expect(speech).toHaveBeenCalledTimes(1));
    expect(speech.mock.calls.map(x=>x[0])).toEqual(['Current third welcome']);
    expect(h.runStarts()).toBe(1);
  });

  it.each(['before','after'] as const)('a superseded welcome arriving %s the current empty welcome leaves the call unwelcomed', async(order)=>{
    const { h, rearm } = await rearmDuringWelcome();
    const supersededArrives = async () => { h.welcomeResponses[0]!({ok:true,result:{assistantText:'Superseded welcome'}}); await drain(); };
    if (order === 'before') await supersededArrives();
    h.welcomeResponses[1]!({ok:true,result:{assistantText:''}});
    await drain();
    if (order === 'after') await supersededArrives();
    expect(speech).not.toHaveBeenCalled();
    await rearm();
    await vi.waitFor(() => expect(h.welcomeResponses).toHaveLength(3));
    h.welcomeResponses[2]!({ok:true,result:{assistantText:'Retry welcome'}});
    await vi.waitFor(() => expect(speech).toHaveBeenCalledTimes(1));
    expect(speech.mock.calls.map(x=>x[0])).toEqual(['Retry welcome']);
    expect(h.runStarts()).toBe(1);
  });

  it.each(['superseded-first','current-first'] as const)('a delivered current welcome still deduplicates the next rearm (%s)', async(order)=>{
    const { h, rearm } = await rearmDuringWelcome();
    const superseded = () => h.welcomeResponses[0]!({ok:true,result:{assistantText:'Superseded welcome'}});
    const current = () => h.welcomeResponses[1]!({ok:true,result:{assistantText:'Current welcome'}});
    if (order === 'superseded-first') { superseded(); await drain(); current(); }
    else { current(); await drain(); superseded(); }
    await vi.waitFor(() => expect(speech).toHaveBeenCalledTimes(1));
    await drain();
    await rearm();
    await drain();
    expect(h.welcomeResponses).toHaveLength(2);
    expect(speech.mock.calls.map(x=>x[0])).toEqual(['Current welcome']);
    expect(h.runStarts()).toBe(1);
  });

  let audioStarts=0;
  // Browser audio hardware only; the real speech owner and byte player run on top of it.
  class TestAudioContext {
    destination={}; async resume() {} async decodeAudioData(_bytes:any) {return {};}
    createBufferSource() {const s:any={connect(){},disconnect(){},stop(){},start(){audioStarts++;queueMicrotask(()=>s.onended?.());}};return s;}
  }

  /** Immediate welcome spoken by the real OpenAI-compatible TTS, holding its audio bytes until released. */
  async function connectWithWelcomeAwaitingTtsBytes() {
    const settings=configureHttpAgent(); const config=settings.voice.adapters.local_conversation;
    config.agent.transcript.epoch=++fixtureEpoch;
    config.agent.prewarmOnConnect=true; config.agent.welcome={enabled:true,mode:'immediate',templateId:null};
    config.tts.provider='openai_compat'; config.tts.openaiCompat.baseUrl='https://tts.test/v1';
    storage.setState({settings});
    const featureFetch=globalThis.fetch;
    let releaseBytes!:(bytes:ArrayBuffer)=>void; const bytes=new Promise<ArrayBuffer>(r=>{releaseBytes=r;});
    let reads=0;
    vi.stubGlobal('fetch',vi.fn(async(input,init:any)=>{
      if(String(input)==='https://tts.test/v1/audio/speech') return {ok:true,arrayBuffer:()=>{reads++;return bytes;}} as unknown as Response;
      return featureFetch(input,init);
    }));
    const engine=await loadEngine();
    await engine.toggleLocalVoiceTurn(controlSessionId);
    await vi.waitFor(()=>expect(reads).toBe(1));
    const {Platform}=await import('react-native'); const previousOS=Platform.OS;
    const playHeldBytes=async()=>{
      (Platform as any).OS='web'; vi.stubGlobal('AudioContext',TestAudioContext); audioStarts=0;
      try { releaseBytes(new Uint8Array([1,2,3]).buffer); await drain(); return audioStarts; }
      finally { (Platform as any).OS=previousOS; }
    };
    return {engine,playHeldBytes};
  }

  it.each(['hang-up','successor turn'] as const)('a welcome still synthesizing when a %s takes over never starts playback',async(boundary)=>{
    const {engine:e,playHeldBytes}=await connectWithWelcomeAwaitingTtsBytes();
    let successor:{release:()=>void;sending:Promise<void>}|undefined;
    if(boundary==='hang-up') await e.stopLocalVoiceSession();
    else successor=await startTurnWithDelayedEnqueueAck(e.sendLocalVoiceAgentTextUpdate);
    const late=recordLateStatePublications(e.getLocalVoiceState,e.subscribeLocalVoiceState);
    const starts=await playHeldBytes();
    late.unsubscribe();
    if(successor){await e.abortLocalVoiceTurn(controlSessionId);successor.release();await successor.sending;expectRowRetainedAsUncertain();}
    expect(starts).toBe(0);
    expect(late.published).toEqual([]);
  });

  it('a welcome that still owns the call plays its synthesized audio',async()=>{
    const {engine:e,playHeldBytes}=await connectWithWelcomeAwaitingTtsBytes();
    expect(await playHeldBytes()).toBe(1);
    expect(e.getLocalVoiceState()).toMatchObject({status:'recording',sessionId:controlSessionId,error:null});
  });

  it('a successor turn stops the native welcome speech it takes over from',async()=>{
    const settings=configureHttpAgent();
    settings.voice.adapters.local_conversation.agent.prewarmOnConnect=true;
    settings.voice.adapters.local_conversation.agent.welcome={enabled:true,mode:'immediate',templateId:null};
    storage.setState({settings});
    const e=await loadEngine();
    let nativeOptions:any;
    speech.mockImplementation((_text,opts)=>{nativeOptions=opts;});
    await e.toggleLocalVoiceTurn(controlSessionId);
    await vi.waitFor(()=>expect(nativeOptions?.onError).toBeTypeOf('function'));
    expect(speechStop).not.toHaveBeenCalled();
    const successor=await startTurnWithDelayedEnqueueAck(e.sendLocalVoiceAgentTextUpdate);
    expect(speechStop).toHaveBeenCalledTimes(1);
    // The platform reports the stop it was asked for; that is not a welcome failure.
    nativeOptions.onStopped();
    await drain();
    await e.abortLocalVoiceTurn(controlSessionId); successor.release(); await successor.sending;
    expectRowRetainedAsUncertain();
    expect(e.getLocalVoiceState()).toMatchObject({sessionId:controlSessionId,error:null});
  });

});
