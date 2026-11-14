// Composed regression for requested-interrupt custody across turns (adopted from independent
// review probes): real runner, prompt tracker, Session, canonical lifecycle,
// ApiSessionClient result-bound mark/notify and the daemon turn owner/proof recorder; only the
// provider query and the session/daemon transports are scripted. Optional SDK_CUSTODY_WITNESS_PATH
// records the witnesses.
const {contractNotices, transport}=vi.hoisted(()=>({contractNotices:[] as unknown[],transport:{handle:null as null|((body:any, options:any)=>Promise<unknown>)}}));
vi.mock('@/daemon/controlClient',async(original)=>({...await original<any>(),notifyDaemonConnectedServiceTurnLifecycle:async(...args:unknown[])=>{contractNotices.push(args);return await transport.handle?.(args[0],args[1]) ?? {}}}));
import { ApiSessionClient } from '@/api/session/sessionClient';
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
    const mutations: unknown[]=[];
    const lifecycle = createSessionTurnLifecycle({
        sessionId,
        enqueueSessionTurn: async (mutation) => {mutations.push(mutation);},
        onTurnLifecycleEvent: (event, terminalStatus, turnId) => {
            if (event === 'assistant_message_end') terminals.push({ turnId, terminalStatus });
            void (ApiSessionClient.prototype as any).notifyDaemonConnectedServiceTurnLifecycle.call(client,event,terminalStatus,turnId);

        },
    });
    transport.handle=async(body,options)=>{
        const turnLifecycle=await applyTrackedSessionTurnLifecycle({trackedSessions:[tracked],...body,updateSessionMarkerActiveTurn:async()=>true});
        const admission=await recordTurnLifecycleProviderActivity({...body,turnLifecycle,completionContract:options?.turnCompletionContract ?? null,resolveRecoveryIdentities:()=>[],record:async(input)=>{proofs.push(input)}});
        admissions.push({...body,admission});
        return {ok:true};
    };
    const client = {
        sessionId,
        startedByDaemonProcess:true, resultBoundTurnCompletion:null, daemonTurnLifecycleNotifyTail:Promise.resolve(),
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
        client, path: process.env.TMPDIR!, logPath: process.env.TMPDIR!+'/log', sessionId: null,
        messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
        onModeChange: () => {}, hookSettingsPath: process.env.TMPDIR!+'/hooks.json',
    });
    const onResultBoundCompletion = vi.fn(()=>ApiSessionClient.prototype.markResultBoundTurnCompletion.call(client as any,'claude_sdk_result_bound_v1'));
    return {
        client, lifecycle, terminals, admissions, proofs, tracked, onResultBoundCompletion, session, mutations,
        settleDaemon: async () => { await (client as any).daemonTurnLifecycleNotifyTail; },
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


import { createClaudeRemotePromptSettlementTracker } from './providerPromptAcceptance';
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return{promise,resolve}}
const witnesses:unknown[]=[];
function save(label:string,h:ReturnType<typeof createComposedHarness>,extra:unknown={}){
 witnesses.push({label,extra,active:h.lifecycle.getActiveTurnId(),terminals:[...h.terminals],mutations:[...h.mutations],admissions:[...h.admissions],proofs:[...h.proofs],notices:[...contractNotices]});
 if (process.env.SDK_CUSTODY_WITNESS_PATH) writeFileSync(process.env.SDK_CUSTODY_WITNESS_PATH,JSON.stringify(witnesses,null,2));
}
function launch(h:ReturnType<typeof createComposedHarness>,createQuery:CreateQuery,prompts:string[],finish:ReturnType<typeof gate>,extra:Record<string,unknown>={}){
 let index=0;const gates=prompts.map((_,i)=>i===0?{promise:Promise.resolve(),resolve:()=>{}}:gate());
 let interrupt:(()=>Promise<void>)|null=null;
 const runner=claudeRemoteAgentSdk({sessionId:null,transcriptPath:null,path:process.env.TMPDIR!,claudeArgs:[],claudeExecutablePath:'/no-provider',canCallTool:async()=>({behavior:'allow',updatedInput:{}}),isAborted:()=>false,nextMessage:async()=>{const i=index++;if(i>=prompts.length){await finish.promise;return null}await Promise.race([gates[i].promise,finish.promise]);return{message:prompts[i],mode:makeMode({claudeRemoteAgentSdkEnabled:true})}},onReady:()=>{},onSessionFound:()=>{},onMessage:()=>{},createQuery,...h.runnerCallbacks,setTurnInterrupt:(f:(()=>Promise<void>)|null)=>{interrupt=f},...extra} as any);
 void runner.catch(()=>{});
 return{runner,send:(i:number)=>gates[i]?.resolve(),interrupt:()=>{if(!interrupt)throw Error('missing interrupt');return interrupt()},cleanup:async()=>{gates.forEach(g=>g.resolve());finish.resolve();await runner.catch(()=>{});await h.settleDaemon();h.session.cleanup();h.lifecycle.dispose()}};
}
function result(ids:string[]|undefined,extra:Record<string,unknown>={}){return{type:'result',subtype:'success',session_id:'owned-session',result:'reply',...(ids?{user_message_uuids:ids}:{}),...extra}}
async function next(input:AsyncIterator<SDKUserMessage>){const n=await input.next();if(n.done)throw Error('missing input');return n.value.uuid!}

describe('requested interrupt custody across turns',()=>{
 it.each(['before','after']as const)('interrupt ack %s result, subsequent own prompt remains usable',async(order)=>{
  contractNotices.length=0;const h=createComposedHarness(),finish=gate(),ack=gate(),requested=gate(),errorResult=gate(),genuine=gate();let bStarted=false,errorDone=false;
  const query=(({prompt}:Parameters<CreateQuery>[0])=>({async *[Symbol.asyncIterator](){const input=(prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();const a=await next(input);yield{type:'system',subtype:'init',session_id:'owned-session'};await errorResult.promise;yield result([a],{subtype:'error_during_execution',errors:['interrupted']});errorDone=true;const b=await next(input);bStarted=true;await genuine.promise;yield result([b]);await finish.promise},async interrupt(){requested.resolve();await ack.promise},close(){finish.resolve();ack.resolve();errorResult.resolve();genuine.resolve()}}))as unknown as CreateQuery;
  const run=launch(h,query,['A','B'],finish);let interruptJob:Promise<void>|undefined;
  try{await vi.waitFor(()=>expect(h.lifecycle.hasActiveTurn()).toBe(true));const a=h.lifecycle.getActiveTurnId();interruptJob=run.interrupt();await requested.promise;
   if(order==='before'){ack.resolve();await interruptJob;}
   errorResult.resolve();await vi.waitFor(()=>expect(errorDone).toBe(true));await h.settleDaemon();expect((h.mutations as any[]).filter(x=>x.turnId===a&&['complete','cancel','fail'].includes(x.action)).map(x=>x.action)).toEqual(['cancel']);expect(h.proofs).toEqual([]);
   run.send(1);await vi.waitFor(()=>expect(bStarted).toBe(true));const before=h.lifecycle.getActiveTurnId();expect(before).not.toBeNull();ack.resolve();await interruptJob;await h.settleDaemon();save('interrupt-'+order,h,{a,before,after:h.lifecycle.getActiveTurnId()});expect(h.lifecycle.getActiveTurnId()).toBe(before);
   genuine.resolve();await vi.waitFor(()=>expect(h.terminals.at(-1)).toEqual({turnId:before,terminalStatus:'completed'}));await h.settleDaemon();expect(h.proofs.at(-1)).toMatchObject({completionContract:'claude_sdk_result_bound_v1'});
  }finally{ack.resolve();errorResult.resolve();genuine.resolve();await interruptJob;await run.cleanup()}
 });

 it('earlier A result cannot consume the requested interrupt for active B',async()=>{
  contractNotices.length=0;const h=createComposedHarness(),finish=gate(),ack=gate(),stale=gate(),own=gate();let bStarted=false,staleDone=false;let failure:unknown=null;
  const query=(({prompt}:Parameters<CreateQuery>[0])=>({async *[Symbol.asyncIterator](){const input=(prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();const a=await next(input);yield{type:'system',subtype:'init',session_id:'owned-session'};yield result([a]);const b=await next(input);bStarted=true;await stale.promise;yield result([a]);staleDone=true;await own.promise;yield result([b],{subtype:'error_during_execution',errors:['interrupted B']});await finish.promise},async interrupt(){await ack.promise},close(){finish.resolve();stale.resolve();own.resolve()}}))as unknown as CreateQuery;
  const run=launch(h,query,['A','B'],finish);void run.runner.catch(e=>{failure=String(e)});let interruptJob:Promise<void>|undefined;
  try{await vi.waitFor(()=>expect(h.terminals).toHaveLength(1));run.send(1);await vi.waitFor(()=>expect(bStarted).toBe(true));const b=h.lifecycle.getActiveTurnId();interruptJob=run.interrupt();stale.resolve();await vi.waitFor(()=>expect(staleDone).toBe(true));expect(h.lifecycle.getActiveTurnId()).toBe(b);own.resolve();await vi.waitFor(()=>expect(h.lifecycle.hasActiveTurn()).toBe(false));await h.settleDaemon();save('stale-consumes-interrupt',h,{b,failure});expect((h.mutations as any[]).filter(x=>x.turnId===b&&['complete','cancel','fail'].includes(x.action)).map(x=>x.action)).toEqual(['cancel']);
  }finally{ack.resolve();own.resolve();stale.resolve();await interruptJob;await run.cleanup()}
 });
});
