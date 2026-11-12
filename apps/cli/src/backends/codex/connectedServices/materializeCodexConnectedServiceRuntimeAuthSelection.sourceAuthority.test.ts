import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountSettingsSchema, buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import type { Credentials } from '@/persistence';
import { removeTempDir } from '@/testkit/fs/tempDir';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createSessionRecordFixture, createSessionListResponseFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { switchSessionConnectedServiceAuth } from '@/daemon/connectedServices/sessionAuthSwitch/switchSessionConnectedServiceAuth';
import {
  ConnectedServiceSessionAuthSwitchLockRegistry,
  createConnectedServiceSessionAuthSwitchCore,
} from '@/daemon/connectedServices/runtimeAuth/connectedServiceSessionAuthSwitchCore';
import {
  readConnectedServiceStateSharingManifest,
  writeConnectedServiceStateSharingManifest,
} from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';
import { resolveConnectedServiceHomeDir } from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';

import { materializeCodexConnectedServiceRuntimeAuthSelection } from './materializeCodexConnectedServiceRuntimeAuthSelection';
import { resolveCodexConnectedServiceSwitchContinuity } from './resolveCodexConnectedServiceSwitchContinuity';
import { syncCodexConnectedServiceHome } from './syncCodexConnectedServiceHome';

const { io } = vi.hoisted(() => ({ io: vi.fn() }));
vi.mock('socket.io-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('socket.io-client')>(),
  io,
}));

type StateMode = 'isolated' | 'shared';

/**
 * Real account switches (switch core, continuity resolver, runtime materializer, Codex home sync and
 * manifest I/O) for one tracked session. Server HTTP, the session socket's apply reply and
 * post-switch provider verification are synthetic; none of them names a native source.
 */
describe('Codex runtime account switch native source authority', () => {
  const cleanup: Array<() => void | Promise<void>> = [];
  beforeEach(() => { io.mockReset(); });
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
    vi.restoreAllMocks();
  });

  async function createSwitchFixture(params: Readonly<{
    origin: 'terminal' | 'daemon';
    stateMode: StateMode;
    oldHomeProvenance: 'recorded' | 'unrecorded';
  }>) {
    const root = await mkdtemp(join(tmpdir(), 'codex-switch-source-'));
    cleanup.push(() => removeTempDir(root));
    const activeServerDir = join(root, 'server');
    const callerSource = join(root, 'caller-native');
    const daemonSource = join(root, 'daemon-native');
    await mkdir(callerSource, { recursive: true });
    await writeFile(join(callerSource, 'AGENTS.md'), 'caller config\n');
    const homeOf = (profileId: string) => join(
      resolveConnectedServiceHomeDir({ activeServerDir, serviceId: 'openai-codex', profileId, agentId: 'codex' }),
      'codex-home',
    );
    const oldHome = homeOf('old');
    await mkdir(join(oldHome, 'sessions'), { recursive: true });
    await writeFile(join(oldHome, 'sessions', 'private.jsonl'), 'private-history\n');
    const accountSettings = AccountSettingsSchema.parse({
      connectedServicesProviderStateSharingSettingsV1: { byAgentId: { codex: { stateMode: params.stateMode } } },
    });
    // The session's producing caller (a terminal launch, or the daemon when it spawned the session
    // with its then-current environment) admitted callerSource for the session's current home.
    await syncCodexConnectedServiceHome({
      destinationCodexHome: oldHome,
      processEnv: { HOME: root, CODEX_HOME: callerSource },
      accountSettings,
      nativeSourceAuthority: 'caller_env',
    });
    if (params.oldHomeProvenance === 'unrecorded') {
      const { nativeSourceEnv: _recorded, ...legacy } = await readConnectedServiceStateSharingManifest(oldHome);
      await writeConnectedServiceStateSharingManifest(oldHome, legacy);
    }

    const remoteSession = createSessionRecordFixture({ id: 'sess_1', encryptionMode: 'plain' });
    const relay = Fastify();
    relay.get('/v2/sessions/sess_1', async () => ({ session: remoteSession }));
    relay.get('/v2/sessions', async () => createSessionListResponseFixture([remoteSession]));
    relay.get('/v2/sessions/archived', async () => createSessionListResponseFixture([]));
    await relay.ready();
    cleanup.push(() => relay.close());
    cleanup.push(installAxiosFastifyAdapter({ app: relay, origin: new URL(resolveServerHttpBaseUrl()).origin }));
    io.mockImplementation(() => createApiSessionSocketStub({
      emit: (event, args) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        const [, acknowledge] = args as [unknown, (response: unknown) => void];
        acknowledge({ ok: true, result: {
          ok: true, appliedVia: 'direct_live_hot_auth', verification: { activeAccountId: 'acct_target' },
        } });
      },
    }));

    const credential = buildConnectedServiceCredentialRecord({
      now: 1_000, serviceId: 'openai-codex', profileId: 'target', kind: 'oauth', expiresAt: 2_000,
      oauth: {
        accessToken: 'access', refreshToken: 'refresh', idToken: 'id', scope: null, tokenType: null,
        providerAccountId: 'acct_target', providerEmail: 'target@example.test',
      },
    });
    const tracked: Record<string, unknown> = {
      startedBy: params.origin === 'daemon' ? 'daemon' : 'happy directly - likely by user from terminal',
      happySessionId: 'sess_1',
      pid: 123,
      happySessionMetadataFromLocalWebhook: createTestMetadata({ agentRuntimeDescriptorV1: { v: 1, providerId: 'codex', provider: {
        home: 'connectedService', homePath: oldHome, connectedServiceId: 'openai-codex', connectedServiceProfileId: 'old',
      } } }),
      // A daemon-spawned session carries respawn options from the start; a terminal session gains
      // them during its first accepted switch. Neither makes the daemon's environment its source.
      ...(params.origin === 'daemon'
        ? { spawnOptions: { directory: root, backendTarget: { kind: 'builtInAgent', agentId: 'codex' } } }
        : {}),
    };
    const core = createConnectedServiceSessionAuthSwitchCore({ locks: new ConnectedServiceSessionAuthSwitchLockRegistry() });

    const switchTo = async (profileId: string) => await switchSessionConnectedServiceAuth({
      core,
      getChildren: () => [tracked],
      api: {
        readConnectedServiceCredentialHealth: async () => ({ kind: 'found', status: 'connected', health: null }),
        getConnectedServiceAuthGroup: async () => null,
      },
      postSwitchVerificationMode: { kind: 'disabled_for_test_only', reason: 'synthetic provider RPC; asserts pre-provider source selection' },
      resolveContinuity: async (input: unknown) => resolveCodexConnectedServiceSwitchContinuity(input as never),
      materializeRuntimeAuthSelection: async (input: unknown) => materializeCodexConnectedServiceRuntimeAuthSelection({
        credentials: { token: 'machine-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } } satisfies Credentials,
        api: {} as never,
        activeServerDir,
        // The daemon's current environment names another source (it changed since any spawn).
        processEnv: { HOME: root, CODEX_HOME: daemonSource },
        accountSettings,
        input,
        baseSelection: {
          serviceId: 'openai-codex',
          binding: { source: 'connected', selection: 'profile', profileId },
          profileId,
          credentialRevision: null,
          record: { ...credential, profileId },
        },
      } as never),
      hotApply: async ({ runtimeAuthSelectionsByServiceId }: { runtimeAuthSelectionsByServiceId?: ReadonlyMap<string, unknown> }) => {
        const selected = runtimeAuthSelectionsByServiceId?.get('openai-codex') as {
          applyConnectedServiceAuthGeneration: (request: unknown) => Promise<unknown>;
        };
        return await selected.applyConnectedServiceAuthGeneration({ serviceId: 'openai-codex' });
      },
      restartSession: async () => { throw new Error('Unexpected restart'); },
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      persistSessionBindings: async () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'profile', profileId } } },
      },
    } as never);

    const daemonSourceTouched = async () => (await readdir(root)).includes('daemon-native');
    // A refused switch may reject or return a typed failure; either way it carries the refusal code.
    const switchRefusal = async (profileId: string): Promise<string> => {
      try {
        const result = await switchTo(profileId);
        expect(result).toMatchObject({ ok: false });
        return JSON.stringify(result);
      } catch (error) {
        return String((error as { code?: unknown })?.code);
      }
    };
    return { root, callerSource, daemonSource, homeOf, tracked, switchTo, switchRefusal, daemonSourceTouched, accountSettings };
  }

  it.each([
    ['terminal', 'isolated'],
    ['terminal', 'shared'],
    ['daemon', 'isolated'],
    ['daemon', 'shared'],
  ] as const)('keeps the admitted source across two accepted switches (%s-origin session, %s state)', async (origin, stateMode) => {
    const fixture = await createSwitchFixture({ origin, stateMode, oldHomeProvenance: 'recorded' });
    for (const profileId of ['target', 'second']) {
      const switched = await fixture.switchTo(profileId);
      expect(switched).toMatchObject({ ok: true, action: 'hot_applied' });
      expect(fixture.tracked.spawnOptions).toBeTruthy();
      expect((await readConnectedServiceStateSharingManifest(fixture.homeOf(profileId))).nativeSourceEnv?.CODEX_HOME)
        .toBe(fixture.callerSource);
      expect(await fixture.daemonSourceTouched()).toBe(false);
    }
  });

  it.each(['terminal', 'daemon'] as const)('refuses a %s-origin switch whose admitted source is unrecorded, before any write', async (origin) => {
    const fixture = await createSwitchFixture({ origin, stateMode: 'shared', oldHomeProvenance: 'unrecorded' });
    expect(await fixture.switchRefusal('target')).toContain('connected_service_native_source_unrecorded');
    await expect(readFile(join(fixture.homeOf('target'), 'auth.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fixture.daemonSourceTouched()).toBe(false);
  });

  it('refuses a switch into a home another source produced, leaving that home unchanged', async () => {
    const fixture = await createSwitchFixture({ origin: 'terminal', stateMode: 'shared', oldHomeProvenance: 'recorded' });
    const otherSource = join(fixture.root, 'other-native');
    await mkdir(otherSource, { recursive: true });
    await syncCodexConnectedServiceHome({
      destinationCodexHome: fixture.homeOf('target'),
      processEnv: { HOME: fixture.root, CODEX_HOME: otherSource },
      accountSettings: fixture.accountSettings,
      nativeSourceAuthority: 'caller_env',
    });
    await writeFile(join(fixture.homeOf('target'), 'auth.json'), 'other-session-auth');
    expect(await fixture.switchRefusal('target')).toContain('connected_service_native_source_conflict');
    expect(await readFile(join(fixture.homeOf('target'), 'auth.json'), 'utf8')).toBe('other-session-auth');
    expect((await readConnectedServiceStateSharingManifest(fixture.homeOf('target'))).nativeSourceEnv?.CODEX_HOME)
      .toBe(otherSource);
    expect(await fixture.daemonSourceTouched()).toBe(false);
  });

  it('shares a home already produced from the same admitted source', async () => {
    const fixture = await createSwitchFixture({ origin: 'terminal', stateMode: 'shared', oldHomeProvenance: 'recorded' });
    await syncCodexConnectedServiceHome({
      destinationCodexHome: fixture.homeOf('target'),
      processEnv: { HOME: fixture.root, CODEX_HOME: fixture.callerSource },
      accountSettings: fixture.accountSettings,
      nativeSourceAuthority: 'caller_env',
    });
    const switched = await fixture.switchTo('target');
    expect(switched).toMatchObject({ ok: true, action: 'hot_applied' });
    expect((await readConnectedServiceStateSharingManifest(fixture.homeOf('target'))).nativeSourceEnv?.CODEX_HOME)
      .toBe(fixture.callerSource);
    expect(await fixture.daemonSourceTouched()).toBe(false);
  });
});
