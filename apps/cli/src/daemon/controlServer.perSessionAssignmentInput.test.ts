import { describe, expect, it, vi } from 'vitest';
import { CONNECTED_SERVICE_INTERNAL_ASSIGNMENT_FIELDS } from '@happier-dev/protocol';

import { deriveConnectedServiceRunMaterializeToken } from './connectedServices/broker/brokerRefreshCapabilityToken';
import { createDaemonControlApp } from './controlServer';

/**
 * Spec A.1 / T15 at the daemon control-server ingresses: callers may request `initialProfileId`;
 * per-session assignment state is daemon-owned and never accepted from a caller.
 */
const CONTROL_TOKEN = 'fixture-control-token';
const RUN_SCOPE_TOKEN = deriveConnectedServiceRunMaterializeToken(CONTROL_TOKEN);
const MATERIALIZE_PATH = '/connected-service-auth/execution-run/materialize';

const FORGED_VALUES: Record<string, unknown> = {
  member: { assignment: 'per_session', profileId: 'B', decisionId: 'forged-decision', reason: 'initial_sampled', appliedAtMs: 1 },
  materializedAssignment: { profileId: 'B', decisionId: 'forged-decision', reason: 'initial_sampled', materializedAtMs: 1 },
  pendingAssignment: { profileId: 'B' },
  decisionId: 'forged-decision',
};

const group = (extra: Record<string, unknown> = {}) => ({
  v: 1,
  bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool', ...extra } },
});

function buildApp() {
  const spawnSession = vi.fn(async (_options: Record<string, unknown>) => ({ type: 'success' as const, sessionId: 'session' }));
  const materialize = vi.fn(async (_request: Record<string, unknown>) => {
    throw new Error('STOP_AT_MATERIALIZATION');
  });
  const app = createDaemonControlApp({
    getChildren: () => [],
    machineId: 'machine',
    stopSession: async () => ({ status: 'not_found' as const }),
    spawnSession,
    requestShutdown: () => {},
    onHappySessionWebhook: () => {},
    controlToken: CONTROL_TOKEN,
    handleExecutionRunConnectedServiceMaterialize: materialize,
  } as unknown as Parameters<typeof createDaemonControlApp>[0]);
  return { app, spawnSession, materialize };
}

async function withApp(run: (built: ReturnType<typeof buildApp>) => Promise<void>): Promise<void> {
  const built = buildApp();
  try {
    await built.app.ready();
    await run(built);
  } finally {
    await built.app.close();
  }
}

const spawn = (app: ReturnType<typeof buildApp>['app'], payload: Record<string, unknown>) => app.inject({
  method: 'POST',
  url: '/spawn-session',
  headers: { 'x-happier-daemon-token': CONTROL_TOKEN },
  payload,
});

const materializeRequest = (app: ReturnType<typeof buildApp>['app'], connectedServicesBindingsRaw: unknown) => app.inject({
  method: 'POST',
  url: MATERIALIZE_PATH,
  headers: { 'x-happier-daemon-token': RUN_SCOPE_TOKEN },
  payload: {
    runId: 'run',
    agentId: 'claude',
    pid: 1000,
    materializationKey: 'execution_run:probe',
    sessionId: 'session',
    connectedServicesBindingsRaw,
  },
});

describe('daemon control server: per-session assignment input provenance (spec A.1)', () => {
  for (const field of CONNECTED_SERVICE_INTERNAL_ASSIGNMENT_FIELDS) {
    it(`new spawn rejects caller ${field} before the spawn executor`, async () => {
      await withApp(async ({ app, spawnSession }) => {
        const res = await spawn(app, { directory: '/project', connectedServices: group({ [field]: FORGED_VALUES[field] }) });
        expect(res.statusCode).toBe(400);
        expect(res.json().errorCode).toBe('connected_service_internal_assignment_field_forbidden');
        expect(spawnSession).not.toHaveBeenCalled();
      });
    });

    it(`resume drops caller ${field} before the spawn executor (restored only from the session record)`, async () => {
      await withApp(async ({ app, spawnSession }) => {
        const res = await spawn(app, {
          directory: '/project',
          existingSessionId: 'session',
          connectedServices: group({ initialProfileId: 'A', [field]: FORGED_VALUES[field] }),
        });
        expect(res.statusCode).toBe(200);
        expect(spawnSession).toHaveBeenCalledTimes(1);
        expect(spawnSession.mock.calls[0]![0].connectedServices).toEqual(group({ initialProfileId: 'A' }));
      });
    });

    it(`run-scoped materialize rejects caller ${field} before the materializer`, async () => {
      await withApp(async ({ app, materialize }) => {
        const res = await materializeRequest(app, group({ [field]: FORGED_VALUES[field] }));
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({
          ok: false,
          errorCode: 'connected_service_internal_assignment_field_forbidden',
          fields: [`claude-subscription.${field}`],
        });
        expect(materialize).not.toHaveBeenCalled();
      });
    });
  }

  it('positive control: a new spawn with an explicit named start reaches the spawn executor unchanged', async () => {
    await withApp(async ({ app, spawnSession }) => {
      const res = await spawn(app, { directory: '/project', connectedServices: group({ initialProfileId: 'A' }) });
      expect(res.statusCode).toBe(200);
      expect(spawnSession.mock.calls[0]![0].connectedServices).toEqual(group({ initialProfileId: 'A' }));
    });
  });

  it('positive control: run-scoped materialize admits a group with a named start', async () => {
    await withApp(async ({ app, materialize }) => {
      await materializeRequest(app, group({ initialProfileId: 'A' }));
      expect(materialize).toHaveBeenCalledTimes(1);
      expect(materialize.mock.calls[0]![0].connectedServicesBindingsRaw).toEqual(group({ initialProfileId: 'A' }));
    });
  });
});
