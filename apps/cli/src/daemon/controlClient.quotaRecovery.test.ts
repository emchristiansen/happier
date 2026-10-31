import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifyDaemonConnectedServiceTurnLifecycle } from './controlClient';
import { createDaemonControlApp } from './controlServer';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';

vi.mock('@/persistence', async (original) => ({
  ...await original<typeof import('@/persistence')>(),
  readDaemonState: async () => ({ pid: 123, httpPort: 4321, controlToken: 'fixture-token' }),
}));

afterEach(() => vi.restoreAllMocks());

describe('daemon quota native completion source', () => {
  it('captures the quota source before awaited runtime-auth intake and finalizes only an accepted result', async () => {
    const events: string[] = [];
    const begin = vi.fn(() => {
      events.push('captured');
      return (_attemptId?: string) => { events.push('acknowledged'); };
    });
    const app = createDaemonControlApp({ getChildren: () => [], machineId: 'machine', controlToken: 'inert-token',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'forbidden' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, beginQuotaFailureSource: begin,
      handleConnectedServiceRuntimeAuthFailure: async () => {
        expect(events).toEqual(['captured']);
        await Promise.resolve();
        events.push('handled');
        return { status: 'switch_reason_disabled' };
      } });
    const source = { nativeId: 'native', pid: 123, publisherIncarnationId: 'publisher', sequence: '1' };
    try {
      const response = await app.inject({ method: 'POST', url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'inert-token', 'x-happier-native-provider-source': JSON.stringify(source) },
        payload: { reportId: 'runtime-auth-report:fixture', sessionId: 'session', classification: {
          kind: 'usage_limit', serviceId: 'openai-codex', profileId: 'old', groupId: null,
          resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error',
        } } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true });
      expect(begin).toHaveBeenCalledWith(expect.objectContaining({ nativeProviderSource: source }));
      expect(events).toEqual(['captured', 'handled', 'acknowledged']);
    } finally { await app.close(); }
  });
  it('keeps the guarded switch envelope and refuses unauthenticated inspection', async () => {
    const guard = { requestId: 'once', nativeId: 'native', pid: 123, processInstanceFingerprint: 'instance',
      serviceId: 'openai-codex' as const, profileId: 'old', failureAttemptId: 'failure', failureArmedAtMs: 1,
      nativePublisherIncarnationId: 'publisher', nativeObservationSequence: '1', failureObservedAtMs: 2 };
    const request = { sessionId: 'session', agentId: 'codex', bindings: { v: 1,
      bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'profile', profileId: 'next' } } },
      quotaRecovery: guard };
    const occurrence = { protocolVersion: 1, stage: 'restart_requested', requestId: 'once' };
    const switchAccount = vi.fn(async () => ({ ok: true, occurrence }));
    const inspect = vi.fn(() => ({ ok: true, occurrence }));
    const app = createDaemonControlApp({ getChildren: () => [], machineId: 'machine', controlToken: 'inert-token',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'forbidden' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {},
      inspectSessionQuotaRecovery: inspect, handleSessionConnectedServiceAuthSwitch: switchAccount });
    try {
      const refused = await app.inject({ method: 'POST', url: '/connected-service-auth/session/quota-recovery/inspect',
        payload: { sessionId: 'session' } });
      expect(refused.statusCode).toBe(401);
      expect(inspect).not.toHaveBeenCalled();
      const switched = await app.inject({ method: 'POST', url: '/connected-service-auth/session/switch',
        headers: { 'x-happier-daemon-token': 'inert-token' }, payload: request });
      expect(switched.statusCode).toBe(200);
      expect(switched.json()).toEqual({ ok: true, result: { ok: true, occurrence } });
      expect(switchAccount).toHaveBeenCalledWith(request);
      const readback = await app.inject({ method: 'POST', url: '/connected-service-auth/session/quota-recovery/inspect',
        headers: { 'x-happier-daemon-token': 'inert-token' }, payload: { sessionId: 'session', requestId: 'once' } });
      expect(readback.json()).toEqual({ ok: true, occurrence });
    } finally { await app.close(); }
  });
  it('carries native source separately from the released strict lifecycle body', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    const requests: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: unknown, options: RequestInit) => {
      requests.push(options);
      return new Response(JSON.stringify({ ok: true, result: {
        status: 'continue', turnCustody: { status: 'recorded', activeTurnId: null },
      } }), { status: 200 });
    });
    const source = { nativeId: 'same-native', pid: 123, publisherIncarnationId: 'same-publisher', sequence: '1' };
    const body = { sessionId: 'same-session', event: 'assistant_message_end' as const,
      terminalStatus: 'completed' as const, turnId: 'turn-1' };
    await notifyDaemonConnectedServiceTurnLifecycle(body, Object.assign({}, { nativeProviderSource: source }));
    expect(JSON.parse(String(requests[0].body))).toEqual(body);
    expect(new Headers(requests[0].headers).get('x-happier-native-provider-source')).toBe(JSON.stringify(source));
    await notifyDaemonConnectedServiceTurnLifecycle(body);
    expect(JSON.parse(String(requests[1].body))).toEqual(body);
    expect(new Headers(requests[1].headers).get('x-happier-native-provider-source')).toBeNull();
  });
});
