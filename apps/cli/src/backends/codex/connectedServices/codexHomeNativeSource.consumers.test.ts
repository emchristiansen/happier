import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { removeTempDir } from '@/testkit/fs/tempDir';
import { materializeConnectedServicesForSpawn } from '@/daemon/connectedServices/materialize/materializeConnectedServicesForSpawn';
import { resolveConnectedServiceHomeDir } from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';
import {
  DEFAULT_MANIFEST_NAME,
  readConnectedServiceStateSharingManifest,
  writeConnectedServiceStateSharingManifest,
} from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';

import { withCodexAppServerControlClient } from '../appServer/control/withCodexAppServerControlClient';
import { listCodexSessionCandidates } from '../directSessions/listCodexSessionCandidates';

/**
 * RUNTIME-F1: a connected-service home's consumers launch Codex from a runtime descriptor or a direct
 * listing source that carries only the home path. They must run it with the SQLite home its producer
 * chose (the admitted native source's, for a shared home), never the consumer's ambient
 * CODEX_SQLITE_HOME. Real producer, manifest, descriptor reader, control wrapper and listing; only the
 * final app-server transport is replaced, to capture its launch environment.
 */
const transport = vi.hoisted(() => ({ launches: [] as NodeJS.ProcessEnv[] }));
vi.mock('../appServer/client/withCodexAppServerClient', () => ({
  withCodexAppServerClient: async (params: { processEnv: NodeJS.ProcessEnv; run: (client: unknown) => Promise<unknown> }) => {
    transport.launches.push(params.processEnv);
    return await params.run({ request: async () => ({ data: [], nextCursor: null }) });
  },
}));

const sharedSettings = { connectedServicesProviderStateSharingSettingsV1: { byAgentId: { codex: { stateMode: 'shared' } } } };
const record = buildConnectedServiceCredentialRecord({
  now: 1000, serviceId: 'openai-codex', profileId: 'synthetic', kind: 'oauth', expiresAt: null,
  oauth: {
    accessToken: 'synthetic', refreshToken: 'synthetic-refresh', idToken: null, scope: null, tokenType: null,
    providerAccountId: 'synthetic', providerEmail: null,
  },
});
const isolatedLegacyManifest = {
  v: 1, requestedStateMode: 'isolated', effectiveStateMode: 'isolated', lastSyncAtMs: 1,
  configEntries: [], stateEntries: [], sessionFileMappings: [], diagnostics: [],
} as const;

const roots: string[] = [];
afterEach(async () => {
  transport.launches.length = 0;
  await Promise.all(roots.splice(0).map((root) => removeTempDir(root)));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codex-home-native-source-consumers-'));
  roots.push(root);
  const activeServerDir = join(root, 'server');
  const home = join(resolveConnectedServiceHomeDir({
    activeServerDir, serviceId: 'openai-codex', profileId: 'synthetic', agentId: 'codex',
  }), 'codex-home');
  await mkdir(home, { recursive: true });
  const daemonSqlite = join(root, 'daemon-sqlite');
  const produce = async (
    source: Readonly<{ CODEX_HOME: string; CODEX_SQLITE_HOME: string }>,
    accountSettings: Readonly<Record<string, unknown>> = sharedSettings,
  ) => await materializeConnectedServicesForSpawn({
    agentId: 'codex', activeServerDir, materializationKey: 'synthetic-session', baseDir: join(root, 'runs'),
    sessionDirectory: root, recordsByServiceId: new Map([['openai-codex', record]]), nativeSourceAuthority: 'caller_env',
    processEnv: { HOME: root, ...source }, accountSettings,
  });
  const control = async (descriptor: Readonly<Record<string, unknown>>) => await withCodexAppServerControlClient({
    cwd: root,
    processEnv: { HOME: root, CODEX_HOME: daemonSqlite, CODEX_SQLITE_HOME: daemonSqlite },
    metadata: { agentRuntimeDescriptorV1: { v: 1, providerId: 'codex', provider: { backendMode: 'appServer', home: 'connectedService', homePath: home, ...descriptor } } },
    run: async () => 'consumer-reached',
  });
  const list = async () => await listCodexSessionCandidates({
    source: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'openai-codex', connectedServiceProfileId: 'synthetic', homePath: home },
    activeServerDir, env: { HOME: root, CODEX_HOME: daemonSqlite, CODEX_SQLITE_HOME: daemonSqlite }, limit: 10,
  });
  return { root, home, daemonSqlite, produce, control, list };
}

describe('Codex connected-service home consumers keep the producer-chosen SQLite home', () => {
  it('a legacy isolated home re-admitted as its own source: control and listing use the home, not the daemon environment', async () => {
    const f = await fixture();
    await writeConnectedServiceStateSharingManifest(f.home, isolatedLegacyManifest);

    const produced = await f.produce({ CODEX_HOME: f.home, CODEX_SQLITE_HOME: f.home });
    expect(produced?.env.CODEX_SQLITE_HOME).toBe(f.home);
    expect(await readConnectedServiceStateSharingManifest(f.home)).toMatchObject({
      requestedStateMode: 'shared', effectiveStateMode: 'shared',
      nativeSourceEnv: { CODEX_HOME: f.home, CODEX_SQLITE_HOME: f.home },
    });

    expect(await f.control({})).toEqual({ ok: true, value: 'consumer-reached' });
    await f.list();
    expect(transport.launches.map(({ CODEX_HOME, CODEX_SQLITE_HOME }) => ({ CODEX_HOME, CODEX_SQLITE_HOME }))).toEqual([
      { CODEX_HOME: f.home, CODEX_SQLITE_HOME: f.home },
      { CODEX_HOME: f.home, CODEX_SQLITE_HOME: f.home },
    ]);
  });

  it('a shared home produced from a separate native source: consumers use that source SQLite home', async () => {
    const f = await fixture();
    const source = { CODEX_HOME: join(f.root, 'native'), CODEX_SQLITE_HOME: join(f.root, 'native-sqlite') };
    await mkdir(source.CODEX_HOME, { recursive: true });

    const produced = await f.produce(source);
    expect(produced?.env.CODEX_SQLITE_HOME).toBe(source.CODEX_SQLITE_HOME);

    expect(await f.control({})).toEqual({ ok: true, value: 'consumer-reached' });
    await f.list();
    expect(transport.launches.map((env) => env.CODEX_SQLITE_HOME)).toEqual([source.CODEX_SQLITE_HOME, source.CODEX_SQLITE_HOME]);
  });

  it('an explicit persisted SQLite affinity still takes precedence over the recorded source', async () => {
    const f = await fixture();
    await f.produce({ CODEX_HOME: f.home, CODEX_SQLITE_HOME: f.home });
    const persisted = join(f.root, 'persisted-sqlite');

    expect(await f.control({ sqliteHomePath: persisted })).toEqual({ ok: true, value: 'consumer-reached' });
    expect(transport.launches.map((env) => env.CODEX_SQLITE_HOME)).toEqual([persisted]);
  });

  it.each([
    ['its own home', true],
    ['a separate native home', false],
  ] as const)('shared → isolated → shared with %s and a distinct SQLite home: consumers follow each producer choice', async (_label, selfSource) => {
    const f = await fixture();
    const source = { CODEX_HOME: selfSource ? f.home : join(f.root, 'native'), CODEX_SQLITE_HOME: join(f.root, 'native-sqlite') };
    await mkdir(source.CODEX_HOME, { recursive: true });
    const settings = (stateMode: 'shared' | 'isolated') => ({
      connectedServicesProviderStateSharingSettingsV1: { byAgentId: { codex: { stateMode, configMode: 'isolated' } } },
    });

    for (const stateMode of ['shared', 'isolated', 'shared'] as const) {
      transport.launches.length = 0;
      const produced = await f.produce(source, settings(stateMode));
      const expectedSqlite = stateMode === 'shared' ? source.CODEX_SQLITE_HOME : f.home;
      expect(produced?.env.CODEX_SQLITE_HOME).toBe(expectedSqlite);
      expect(await readConnectedServiceStateSharingManifest(f.home)).toMatchObject({
        requestedStateMode: stateMode, effectiveStateMode: stateMode, nativeSourceEnv: source,
      });
      expect(await f.control({})).toEqual({ ok: true, value: 'consumer-reached' });
      expect(transport.launches.map((env) => env.CODEX_SQLITE_HOME)).toEqual([expectedSqlite]);
    }
    // The listing snapshot is cached per home and launch environment, so it is read once, last.
    transport.launches.length = 0;
    await f.list();
    expect(transport.launches.map((env) => env.CODEX_SQLITE_HOME)).toEqual([source.CODEX_SQLITE_HOME]);
  });

  it.each([
    ['malformed', { CODEX_HOME: 'relative/home', CODEX_SQLITE_HOME: 'relative/sqlite' }],
    ['incomplete', { CODEX_HOME: '/absolute/home-only' }],
  ] as const)('a shared home with a %s source record is refused, never run against the daemon SQLite home', async (_kind, nativeSourceEnv) => {
    const f = await fixture();
    await f.produce({ CODEX_HOME: f.home, CODEX_SQLITE_HOME: f.home });
    const manifestPath = join(f.home, DEFAULT_MANIFEST_NAME);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, nativeSourceEnv }));

    expect(await f.control({})).toEqual({
      ok: false, errorCode: 'codex_app_server_control_unavailable', error: 'codex_app_server_control_unavailable',
    });
    await expect(f.list()).rejects.toMatchObject({ code: 'connected_service_native_source_invalid' });
    expect(transport.launches).toEqual([]);
  });
});
