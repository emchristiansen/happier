import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { formatPiSessionDirectoryForCwd } from '@/backends/pi/utils/piSessionFiles';
import { verifySpawnResumeReachability } from '@/daemon/connectedServices/verifySpawnResumeReachability';
import { HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';

import { createPiConnectedServicesMaterializer } from './createPiConnectedServicesMaterializer';

function buildSharedStateAccountSettings() {
  return {
    connectedServicesProviderStateSharingSettingsV1: {
      v: 1,
      defaults: { configMode: 'linked', stateMode: 'isolated' },
      byAgentId: { pi: { configMode: 'linked', stateMode: 'shared' } },
      acknowledgedRisksByAgentId: { pi: { sharedStatePrivacy: true } },
    },
  } as const;
}

describe('createPiConnectedServicesMaterializer', () => {
  it('routes shared-state PI session import through descriptor materialization and writes manifest mappings', async () => {
    const now = Date.now();
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-pi-active-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-pi-materialized-root-'));
    const sourceAgentDir = await mkdtemp(join(tmpdir(), 'happier-pi-source-agent-'));
    const sourceSessionDir = join(sourceAgentDir, 'sessions', '--tmp-project--');
    await mkdir(sourceSessionDir, { recursive: true });
    await writeFile(join(sourceSessionDir, '2026-05-21T00-00-00-000Z_pi-session-1.jsonl'), '{"id":"pi-session-1"}\n');

    const anthropic = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'anthropic',
      profileId: 'default',
      kind: 'token',
      token: { token: 'sk-ant-test', providerAccountId: null, providerEmail: null },
    });

    const materializer = createPiConnectedServicesMaterializer();
    const result = await materializer({
      nativeSourceAuthority: 'caller_env',
      agentId: 'pi',
      activeServerDir,
      rootDir,
      sessionDirectory: '/tmp/project',
      recordsByServiceId: new Map([['anthropic', anthropic]]),
      accountSettings: {
        connectedServicesProviderStateSharingSettingsV1: {
          v: 1,
          defaults: {
            configMode: 'linked',
            stateMode: 'isolated',
          },
          byAgentId: {
            pi: {
              configMode: 'linked',
              stateMode: 'shared',
            },
          },
          acknowledgedRisksByAgentId: {
            pi: {
              sharedStatePrivacy: true,
            },
          },
        },
      },
      processEnv: {
        HOME: tmpdir(),
        PI_CODING_AGENT_DIR: sourceAgentDir,
      },
      cleanupRoot: async () => {},
    });

    expect(result).not.toBeNull();
    const piAgentDir = result!.env.PI_CODING_AGENT_DIR;
    expect(piAgentDir).toBe(join(rootDir, 'pi-agent-dir'));
    expect(result!.env.PI_CODING_AGENT_SESSION_DIR).toBe(join(piAgentDir, 'sessions', '--tmp-project--'));
    await expect(readFile(
      join(piAgentDir, 'sessions', '--tmp-project--', '2026-05-21T00-00-00-000Z_pi-session-1.jsonl'),
      'utf8',
    )).resolves.toBe('{"id":"pi-session-1"}\n');

    const manifestRaw = await readFile(join(rootDir, '.happier-state-sharing.json'), 'utf8');
    expect(JSON.parse(manifestRaw)).toMatchObject({
      requestedStateMode: 'shared',
      effectiveStateMode: 'shared',
      stateEntries: ['sessions/--tmp-project--'],
      sessionFileMappings: [],
    });
  });

  it('keeps legacy PI_CODING_AGENT_SESSION_DIR import fallback for continuity mappings', async () => {
    const now = Date.now();
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-pi-active-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-pi-materialized-root-'));
    const legacySessionDir = await mkdtemp(join(tmpdir(), 'happier-pi-legacy-sessions-'));
    const legacyWorkdirDir = join(legacySessionDir, '--workdir--');
    await mkdir(legacyWorkdirDir, { recursive: true });
    await writeFile(join(legacyWorkdirDir, '2026-05-21T00-00-00-000Z_pi-session-1.jsonl'), '{"id":"pi-session-1"}\n');

    const anthropic = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'anthropic',
      profileId: 'default',
      kind: 'token',
      token: { token: 'sk-ant-test', providerAccountId: null, providerEmail: null },
    });

    const materializer = createPiConnectedServicesMaterializer();
    const result = await materializer({
      nativeSourceAuthority: 'caller_env',
      agentId: 'pi',
      activeServerDir,
      rootDir,
      sessionDirectory: '/tmp/project',
      recordsByServiceId: new Map([['anthropic', anthropic]]),
      accountSettings: {
        connectedServicesProviderStateSharingSettingsV1: {
          v: 1,
          defaults: {
            configMode: 'linked',
            stateMode: 'isolated',
          },
          byAgentId: {
            pi: {
              configMode: 'linked',
              stateMode: 'shared',
            },
          },
          acknowledgedRisksByAgentId: {
            pi: {
              sharedStatePrivacy: true,
            },
          },
        },
      },
      processEnv: {
        HOME: tmpdir(),
        PI_CODING_AGENT_SESSION_DIR: legacySessionDir,
      },
      cleanupRoot: async () => {},
    });

    expect(result).not.toBeNull();
    const piAgentDir = result!.env.PI_CODING_AGENT_DIR;
    await expect(readFile(
      join(piAgentDir, 'sessions', '--tmp-project--', '2026-05-21T00-00-00-000Z_pi-session-1.jsonl'),
      'utf8',
    )).resolves.toBe('{"id":"pi-session-1"}\n');

    const manifestRaw = await readFile(join(rootDir, '.happier-state-sharing.json'), 'utf8');
    expect(JSON.parse(manifestRaw)).toMatchObject({
      requestedStateMode: 'shared',
      effectiveStateMode: 'shared',
      sessionFileMappings: [
        expect.objectContaining({
          vendorResumeId: 'pi-session-1',
        }),
      ],
    });
  });

  it('CS-FINDING-6: backfills a legacy staging session INTO native and exposes it via the shared link, passing the target-strict §2 gate', async () => {
    const now = Date.now();
    const cwd = '/tmp/project';
    const encodedCwd = formatPiSessionDirectoryForCwd(cwd);

    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-pi-active-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-pi-materialized-root-'));
    // Native shared store exists but does NOT yet contain this session (the gap CS-FINDING-6 hits).
    const nativeAgentDir = await mkdtemp(join(tmpdir(), 'happier-pi-native-agent-'));
    await mkdir(join(nativeAgentDir, 'sessions', encodedCwd), { recursive: true });

    // Legacy session lives ONLY in the materialized `pi-sessions` staging root.
    const legacyStagingDir = join(rootDir, 'pi-sessions', '--workdir--');
    await mkdir(legacyStagingDir, { recursive: true });
    await writeFile(join(legacyStagingDir, '2026-05-21T00-00-00-000Z_cmpo1ofsk.jsonl'), '{"id":"cmpo1ofsk"}\n');

    const anthropic = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'anthropic',
      profileId: 'default',
      kind: 'token',
      token: { token: 'sk-ant-test', providerAccountId: null, providerEmail: null },
    });

    const materializer = createPiConnectedServicesMaterializer();
    const result = await materializer({
      nativeSourceAuthority: 'caller_env',
      agentId: 'pi',
      activeServerDir,
      rootDir,
      sessionDirectory: cwd,
      recordsByServiceId: new Map([['anthropic', anthropic]]),
      accountSettings: buildSharedStateAccountSettings(),
      processEnv: { HOME: tmpdir(), PI_CODING_AGENT_DIR: nativeAgentDir },
      cleanupRoot: async () => {},
    });

    expect(result).not.toBeNull();
    const piAgentDir = result!.env.PI_CODING_AGENT_DIR;
    expect(piAgentDir).toBe(join(rootDir, 'pi-agent-dir'));

    // Part A: the legacy staging session is BACKFILLED into the NATIVE shared store (the link source),
    // not into a displaced target.
    await expect(readFile(
      join(nativeAgentDir, 'sessions', encodedCwd, '2026-05-21T00-00-00-000Z_cmpo1ofsk.jsonl'),
      'utf8',
    )).resolves.toBe('{"id":"cmpo1ofsk"}\n');

    // The shared link exposes the backfilled file at the final PI-readable path.
    const linkedEntry = await lstat(join(piAgentDir, 'sessions', encodedCwd));
    expect(linkedEntry.isSymbolicLink()).toBe(true);
    await expect(readFile(
      join(piAgentDir, 'sessions', encodedCwd, '2026-05-21T00-00-00-000Z_cmpo1ofsk.jsonl'),
      'utf8',
    )).resolves.toBe('{"id":"cmpo1ofsk"}\n');

    // No `.local-*` orphan was created from the import↔link collision.
    const sessionsEntries = await readdir(join(piAgentDir, 'sessions'));
    expect(sessionsEntries.filter((name) => name.includes('.local-'))).toEqual([]);

    // Part B: the target-strict §2 spawn gate proves the EXACT final path PI reads → reachable.
    const gateResult = await verifySpawnResumeReachability({
      agentId: 'pi',
      vendorResumeId: 'cmpo1ofsk',
      cwd,
      materializedEnv: {
        ...result!.env,
        [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: rootDir,
      },
      candidatePersistedSessionFile: null,
    });
    expect(gateResult.ok).toBe(true);
  });

  it('CS-FINDING-6: is idempotent across repeat runs — no accumulating .local-* orphan dirs', async () => {
    const now = Date.now();
    const cwd = '/tmp/project';
    const encodedCwd = formatPiSessionDirectoryForCwd(cwd);

    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-pi-active-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-pi-materialized-root-'));
    const nativeAgentDir = await mkdtemp(join(tmpdir(), 'happier-pi-native-agent-'));
    await mkdir(join(nativeAgentDir, 'sessions', encodedCwd), { recursive: true });

    const legacyStagingDir = join(rootDir, 'pi-sessions', '--workdir--');
    await mkdir(legacyStagingDir, { recursive: true });
    await writeFile(join(legacyStagingDir, '2026-05-21T00-00-00-000Z_cmpo1ofsk.jsonl'), '{"id":"cmpo1ofsk"}\n');

    const anthropic = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'anthropic',
      profileId: 'default',
      kind: 'token',
      token: { token: 'sk-ant-test', providerAccountId: null, providerEmail: null },
    });

    const materializer = createPiConnectedServicesMaterializer();
    const run = () => materializer({
      nativeSourceAuthority: 'caller_env',
      agentId: 'pi',
      activeServerDir,
      rootDir,
      sessionDirectory: cwd,
      recordsByServiceId: new Map([['anthropic', anthropic]]),
      accountSettings: buildSharedStateAccountSettings(),
      processEnv: { HOME: tmpdir(), PI_CODING_AGENT_DIR: nativeAgentDir },
      cleanupRoot: async () => {},
    });

    await run();
    await run();
    const finalResult = await run();

    const piAgentDir = finalResult!.env.PI_CODING_AGENT_DIR;
    const sessionsEntries = await readdir(join(piAgentDir, 'sessions'));
    expect(sessionsEntries.filter((name) => name.includes('.local-'))).toEqual([]);
    // The session remains reachable through the link after repeated runs.
    await expect(readFile(
      join(piAgentDir, 'sessions', encodedCwd, '2026-05-21T00-00-00-000Z_cmpo1ofsk.jsonl'),
      'utf8',
    )).resolves.toBe('{"id":"cmpo1ofsk"}\n');
  });
});
