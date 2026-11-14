// Composed regression (requested-interrupt result order and current auth flows): real runner, prompt tracker, auth retry policy, production
// failure functions, Session, lifecycle and daemon turn admission; only the provider query and
// session/daemon transports are scripted. Optional SDK_EXTRA_WITNESS_PATH records the witnesses.
vi.mock("@/daemon/connectedServices/quotas/deliverConnectedServiceQuotaSnapshotToDaemon", () => ({deliverConnectedServiceQuotaSnapshotToDaemon: vi.fn(async () => ({ok: true}))}));
import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from 'vitest';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import { recordTurnLifecycleProviderActivity, type TurnLifecycleProviderActivityAdmission } from '@/daemon/connectedServices/recovery/providerActivityProofRecorder';
import { applyTrackedSessionTurnLifecycle } from '@/daemon/sessions/applyTrackedSessionTurnLifecycle';
import type { TrackedSession } from '@/daemon/types';

import type { EnhancedMode } from '../loop';
import { Session } from '../session';
import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';
import { makeMode } from './claudeRemoteAgentSdk.testkit';
import { surfaceClaudeRateLimitRuntimeIssue, surfaceClaudeRuntimeAuthFailure } from "../connectedServices/surfaceClaudeRuntimeIssues";
import { surfaceClaudeAgentSdkResultFailure } from './surfaceClaudeAgentSdkResultFailure';

type CreateQuery = NonNullable<Parameters<typeof claudeRemoteAgentSdk>[0]['createQuery']>;
type LifecycleEvent = 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled';

/**
 * Real composed path: Agent SDK result -> claudeRemoteAgentSdk -> Session task markers ->
 * SessionTurnLifecycle -> daemon applyTrackedSessionTurnLifecycle -> provider-activity admission.
 * Only the session transport and the daemon's marker-file write are stubbed.
 */
function createComposedHarness() {
    const sessionId = 'happier-session';
    const terminals: Array<Readonly<{ turnId?: string; terminalStatus?: string }>> = [];
    const admissions: Array<Readonly<{ event: LifecycleEvent; terminalStatus?: string; turnId?: string; admission: TurnLifecycleProviderActivityAdmission }>> = [];
    const proofs: unknown[] = [];
    const tracked = { startedBy: 'daemon', happySessionId: sessionId, pid: 4242 } as TrackedSession;
    let daemonChain: Promise<void> = Promise.resolve();
    const lifecycle = createSessionTurnLifecycle({
        sessionId,
        enqueueSessionTurn: async () => {},
        onTurnLifecycleEvent: (event, terminalStatus, turnId) => {
            if (event === 'assistant_message_end') terminals.push({ turnId, terminalStatus });
            daemonChain = daemonChain.then(async () => {
                const turnLifecycle = await applyTrackedSessionTurnLifecycle({
                    trackedSessions: [tracked], sessionId, event,
                    ...(turnId ? { turnId } : {}),
                    updateSessionMarkerActiveTurn: async () => true,
                });
                const admission = await recordTurnLifecycleProviderActivity({
                    sessionId, event,
                    ...(terminalStatus ? { terminalStatus } : {}),
                    turnLifecycle,
                    resolveRecoveryIdentities: () => [],
                    record: async (input) => { proofs.push(input); },
                });
                admissions.push({ event, terminalStatus, turnId, admission });
            });
        },
    });
    const client = {
        sessionId,
        sessionTurnLifecycle: lifecycle,
        rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => ({})) },
        sendSessionEvent: vi.fn(),
        sendClaudeSessionMessage: vi.fn(),
        // Same marker routing as ApiSessionClient.sendAgentMessage.
        sendAgentMessage: vi.fn((provider, body) => {
            void lifecycle.observeAcpLifecycleMarker({ provider, body }).pendingWrite;
        }),
        sendAgentMessageCommitted: vi.fn(async () => {}),
        keepAlive: vi.fn(),
        getMetadataSnapshot: () => null,
        waitForMetadataUpdate: vi.fn(async () => false),
        waitForProviderInputAdmission: async (signal: AbortSignal) => !signal.aborted,
        waitForPendingEligibilityUpdate: vi.fn(async () => false),
        popPendingMessage: vi.fn(async () => false),
        peekActionablePendingMessageQueueV2Count: vi.fn(async () => 0),
        discardPendingMessageQueueV2All: vi.fn(async () => 0),
        discardCommittedMessageLocalIds: vi.fn(async () => 0),
        updateMetadata: vi.fn(),
        updateAgentStateRequestSettlement: vi.fn(async () => {}),
        updateAgentState: vi.fn(),
        sendSessionDeath: vi.fn(),
        flush: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        on: vi.fn(),
        off: vi.fn(),
    } as unknown as SessionClientPort;
    const session = new Session({
        client, path: '/tmp', logPath: '/tmp/log', sessionId: null,
        messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
        onModeChange: () => {}, hookSettingsPath: '/tmp/hooks.json',
    });
    const onResultBoundCompletion = vi.fn();
    return {
        lifecycle, terminals, admissions, proofs, tracked, onResultBoundCompletion, session,
        settleDaemon: async () => { await daemonChain; },
        runnerCallbacks: {
            onThinkingChange: session.onThinkingChange,
            onRateLimitEvent: async (details: any) => { await surfaceClaudeRateLimitRuntimeIssue({client, transcriptPath: null, sessionId: null}, details, "[sdk-review]"); },
            onRuntimeAuthFailureEvent: async (error: unknown) => { await surfaceClaudeRuntimeAuthFailure({client, transcriptPath: null, sessionId: null}, error, "[sdk-review]"); },
            onResultBoundCompletion,
            onResultFailure: async (failure: string, kind?: 'provider_api_error' | 'execution_error') => {
                await surfaceClaudeAgentSdkResultFailure({ session: client as never, failure, kind });
            },
        },
    };
}

function startRunner(params: Readonly<{
    harness: ReturnType<typeof createComposedHarness>;
    createQuery: CreateQuery;
    prompts: readonly string[];
    inputFinished: Promise<void>;
}>) {
    const prompts = [...params.prompts];
    const allowNext: Array<() => void> = [];
    const gates = prompts.map((_, index) => index === 0 ? Promise.resolve() : new Promise<void>((resolve) => { allowNext.push(resolve); }));
    let index = 0;
    const runner = claudeRemoteAgentSdk({
        sessionId: null, transcriptPath: null, path: '/tmp', claudeArgs: [], claudeExecutablePath: '/tmp/claude',
        canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }), isAborted: () => false,
        nextMessage: async () => {
            const current = index++;
            const prompt = prompts[current];
            if (prompt === undefined) {
                await params.inputFinished;
                return null;
            }
            await Promise.race([gates[current], params.inputFinished]);
            return { message: prompt, mode: makeMode({ claudeRemoteAgentSdkEnabled: true }) };
        },
        onReady: () => {}, onSessionFound: () => {}, onMessage: () => {},
        createQuery: params.createQuery,
        ...params.harness.runnerCallbacks,
    } as Parameters<typeof claudeRemoteAgentSdk>[0]);
    return { runner, releaseNextPrompt: () => allowNext.shift()?.() };
}


function gate() { let resolve!:()=>void; const promise=new Promise<void>(r=>{resolve=r});return {promise,resolve}; }
const extraWitnesses:unknown[]=[];
describe('independent c6 composed neighboring boundaries',()=>{
 it('interrupt error result delivered before interrupt acknowledgment is cancelled, never completed',async()=>{
  const h=createComposedHarness();const finish=gate(),interrupted=gate(),processed=gate();let handler:any;let consumed=false,sent=false;
  const createQuery=(({prompt}:Parameters<CreateQuery>[0])=>({
   async *[Symbol.asyncIterator](){const a=await (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]().next();if(a.done)throw Error('no prompt');yield {type:'system',subtype:'init',session_id:'owned-session'};consumed=true;await interrupted.promise;
    yield {type:'result',subtype:'error_during_execution',session_id:'owned-session',errors:['interrupted by user'],user_message_uuid:a.value.uuid};processed.resolve();await finish.promise;
   },async interrupt(){interrupted.resolve();await processed.promise},close(){finish.resolve();interrupted.resolve();processed.resolve()}
  })) as unknown as CreateQuery;
  const runner=claudeRemoteAgentSdk({sessionId:null,transcriptPath:null,path:process.env.TMPDIR!,claudeArgs:[],claudeExecutablePath:'/no-provider',canCallTool:async()=>({behavior:'allow',updatedInput:{}}),isAborted:()=>false,nextMessage:async()=>{if(!sent){sent=true;return {message:'A',mode:makeMode({claudeRemoteAgentSdkEnabled:true})}}await finish.promise;return null},onReady:()=>{},onSessionFound:()=>{},onMessage:()=>{},setTurnInterrupt:x=>{handler=x},createQuery,...h.runnerCallbacks});void runner.catch(()=>{});
  try{await vi.waitFor(()=>{expect(consumed).toBe(true);expect(h.lifecycle.hasActiveTurn()).toBe(true)});const turnId=h.lifecycle.getActiveTurnId();await handler();h.session.abortCurrentTaskTurn();await h.settleDaemon();extraWitnesses.push({label:'interrupt-result-before-ack',turnId,terminals:[...h.terminals],admissions:[...h.admissions],marks:h.onResultBoundCompletion.mock.calls});if (process.env.SDK_EXTRA_WITNESS_PATH) writeFileSync(process.env.SDK_EXTRA_WITNESS_PATH,JSON.stringify(extraWitnesses,null,2));expect(h.terminals.filter(t=>t.terminalStatus==='completed')).toEqual([]);expect(h.admissions.some(a=>a.event==='turn_cancelled'&&a.turnId===turnId)).toBe(true)}finally{finish.resolve();interrupted.resolve();processed.resolve();await runner.catch(()=>{});h.session.cleanup();h.lifecycle.dispose()}
 });
 it.each([true,false])('current attributed auth result willRetry=%s preserves actual return/retry flow',async(willRetry)=>{
  const h=createComposedHarness();const finish=gate(),retry=gate();let sent=false,consumed=false;const seen:unknown[]=[];
  const createQuery=(({prompt}:Parameters<CreateQuery>[0])=>({async *[Symbol.asyncIterator](){const a=await (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]().next();if(a.done)throw Error('no prompt');yield {type:'system',subtype:'init',session_id:'owned-session'};consumed=true;yield {type:'result',subtype:'success',is_error:true,api_error_status:401,result:'authentication_error',session_id:'owned-session',user_message_uuid:a.value.uuid,willRetry};await retry.promise;yield {type:'result',subtype:'success',result:'retry succeeded',session_id:'owned-session',user_message_uuid:a.value.uuid};await finish.promise},close(){finish.resolve();retry.resolve()}})) as unknown as CreateQuery;
  const runner=claudeRemoteAgentSdk({sessionId:null,transcriptPath:null,path:process.env.TMPDIR!,claudeArgs:[],claudeExecutablePath:'/no-provider',canCallTool:async()=>({behavior:'allow',updatedInput:{}}),isAborted:()=>false,nextMessage:async()=>{if(!sent){sent=true;return {message:'A',mode:makeMode({claudeRemoteAgentSdkEnabled:true})}}await finish.promise;return null},onReady:()=>{},onSessionFound:()=>{},onMessage:m=>{seen.push(m)},createQuery,...h.runnerCallbacks});void runner.catch(()=>{});
  try{await vi.waitFor(()=>expect(consumed).toBe(true));if(willRetry){await vi.waitFor(()=>expect(seen.some((m:any)=>m.willRetry===true)).toBe(true));expect(h.lifecycle.hasActiveTurn()).toBe(true);expect(h.terminals).toEqual([]);retry.resolve();await vi.waitFor(()=>expect(h.terminals).toHaveLength(1));expect(h.terminals[0].terminalStatus).toBe('completed');expect(h.onResultBoundCompletion).toHaveBeenCalledTimes(1)}else{await runner;await h.settleDaemon();expect(h.terminals[0]?.terminalStatus).toBe('failed');expect(h.onResultBoundCompletion).not.toHaveBeenCalled()}extraWitnesses.push({label:'auth-flow-'+willRetry,terminals:[...h.terminals],admissions:[...h.admissions],marks:h.onResultBoundCompletion.mock.calls});if (process.env.SDK_EXTRA_WITNESS_PATH) writeFileSync(process.env.SDK_EXTRA_WITNESS_PATH,JSON.stringify(extraWitnesses,null,2))}finally{finish.resolve();retry.resolve();await runner.catch(()=>{});h.session.cleanup();h.lifecycle.dispose()}
 });
});
