import { existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { configuration, reloadConfiguration } from '@/configuration';
import { authChallenge, encodeBase64 } from '@/api/encryption';
import { resolveDaemonSpawnSessionByNonce, spawnDaemonSession } from '@/daemon/controlClient';
import { readCredentials, writeCredentialsLegacy } from '@/persistence';
import type { SpawnDaemonSessionRequest } from '@/rpc/handlers/spawnSessionOptionsContract';
import { isLocalishServerUrl } from '@/server/serverUrlClassification';
import { waitForCondition } from '@/testkit/async/waitFor';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { spawnTestProcess } from '@/testkit/process/spawn';

type ExtraDaemonTestEnv =
  | Readonly<Record<string, string | undefined>>
  | ((context: { homeDir: string; sourceHomeDir: string }) => Readonly<Record<string, string | undefined>>);

export type PreparedDaemonTestHome = {
  homeDir: string;
  sourceHomeDir: string;
  restore: () => Promise<void>;
};

export type DaemonIntegrationCredentialBootstrapResult =
  | { ready: true; bootstrapped: boolean }
  | { ready: false; reason: string };

export async function spawnDaemonSessionWithResolvedIdentity(
  request: SpawnDaemonSessionRequest,
  waitOptions: Readonly<{ timeoutMs: number; intervalMs?: number; label: string }>,
): Promise<{ success: true; sessionId: string }> {
  const response = await spawnDaemonSession(request) as {
    success?: unknown;
    sessionId?: unknown;
    spawnNonce?: unknown;
  };
  if (response.success !== true) {
    throw new Error(`daemon spawn failed: ${JSON.stringify(response)}`);
  }
  if (typeof response.sessionId === 'string' && response.sessionId.length > 0) {
    return { success: true, sessionId: response.sessionId };
  }

  const spawnNonce = typeof response.spawnNonce === 'string' ? response.spawnNonce.trim() : '';
  if (!spawnNonce) {
    throw new Error(`accepted daemon spawn did not provide a resolution nonce: ${JSON.stringify(response)}`);
  }

  let resolvedSessionId: string | null = null;
  let terminalError: string | null = null;
  await waitForCondition(async () => {
    const resolution = await resolveDaemonSpawnSessionByNonce(spawnNonce);
    if (resolution.status === 'success') {
      resolvedSessionId = resolution.sessionId;
      return true;
    }
    if (resolution.status === 'error') {
      terminalError = `${resolution.errorCode}: ${resolution.errorMessage}`;
      return true;
    }
    return false;
  }, waitOptions);

  if (!resolvedSessionId) {
    throw new Error(terminalError ?? `daemon spawn identity did not resolve for nonce ${spawnNonce}`);
  }
  return { success: true, sessionId: resolvedSessionId };
}

async function copyIfExists(sourcePath: string, targetPath: string): Promise<void> {
  if (!existsSync(sourcePath)) {
    return;
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
}

async function copyLogsToSourceHomeBestEffort(options: {
  homeDir: string;
  sourceHomeDir: string;
  runPrefix: string;
}): Promise<void> {
  const sourceLogsDir = join(options.homeDir, 'logs');
  if (!existsSync(sourceLogsDir)) {
    return;
  }

  const targetLogsDir = join(options.sourceHomeDir, 'logs');
  await mkdir(targetLogsDir, { recursive: true });

  const filePrefix = `${options.runPrefix}-${basename(options.homeDir)}`;
  for (const entry of readdirSync(sourceLogsDir)) {
    if (!entry.endsWith('.log')) {
      continue;
    }

    try {
      await copyFile(join(sourceLogsDir, entry), join(targetLogsDir, `${filePrefix}-${entry}`));
    } catch {
      // best-effort
    }
  }
}

function resolveExtraEnv(
  extraEnv: ExtraDaemonTestEnv | undefined,
  context: { homeDir: string; sourceHomeDir: string },
): Readonly<Record<string, string | undefined>> {
  if (!extraEnv) {
    return {};
  }

  return typeof extraEnv === 'function' ? extraEnv(context) : extraEnv;
}

export async function prepareIsolatedDaemonTestHome(options: {
  prefix: string;
  logCopyPrefix?: string;
  extraEnv?: ExtraDaemonTestEnv;
}): Promise<PreparedDaemonTestHome> {
  const sourceHomeDir = configuration.happyHomeDir;
  const sourceSettingsFile = configuration.settingsFile;
  const sourceLegacyKeyFile = configuration.legacyPrivateKeyFile;
  const sourceServerKeyFile = configuration.privateKeyFile;
  const sourceServerId = configuration.activeServerId;
  const sourceServerUrl = configuration.serverUrl;
  const sourceWebappUrl = configuration.webappUrl;
  const sourcePublicServerUrl = configuration.publicServerUrl;

  const parentDir = join(sourceHomeDir, 'tmp');
  await mkdir(parentDir, { recursive: true });
  const homeDir = await createTempDir(options.prefix, parentDir);

  const extraEnv = resolveExtraEnv(options.extraEnv, { homeDir, sourceHomeDir });
  const envScope = createEnvKeyScope([
    'HAPPIER_HOME_DIR',
    'HAPPIER_ACTIVE_SERVER_ID',
    'HAPPIER_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
    'HAPPIER_PUBLIC_SERVER_URL',
    'HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK',
    ...Object.keys(extraEnv),
  ]);

  envScope.patch({
    HAPPIER_HOME_DIR: homeDir,
    HAPPIER_ACTIVE_SERVER_ID: sourceServerId,
    HAPPIER_SERVER_URL: sourceServerUrl,
    HAPPIER_WEBAPP_URL: sourceWebappUrl,
    HAPPIER_PUBLIC_SERVER_URL: sourcePublicServerUrl,
    HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '1',
    ...extraEnv,
  });
  reloadConfiguration();

  await copyIfExists(sourceSettingsFile, configuration.settingsFile);
  await copyIfExists(sourceLegacyKeyFile, configuration.legacyPrivateKeyFile);
  await copyIfExists(sourceServerKeyFile, configuration.privateKeyFile);

  return {
    homeDir,
    sourceHomeDir,
    restore: async () => {
      try {
        if (options.logCopyPrefix) {
          await copyLogsToSourceHomeBestEffort({
            homeDir,
            sourceHomeDir,
            runPrefix: options.logCopyPrefix,
          });
        }
      } finally {
        envScope.restore();
        reloadConfiguration();

        const expectedPrefix = join(parentDir, options.prefix);
        const safeToDelete = homeDir.startsWith(expectedPrefix);
        if (!safeToDelete) {
          process.stderr.write(
            `[daemon.testkit cleanup] Refusing to delete unexpected isolated home dir: ${homeDir}\n`,
          );
          return;
        }

        await removeTempDir(homeDir);
      }
    },
  };
}

export function shouldRunDaemonReattachIntegration(): boolean {
  return process.env.HAPPIER_CLI_DAEMON_REATTACH_INTEGRATION === '1';
}

function shouldAttemptDaemonIntegrationCredentialBootstrap(): boolean {
  const raw = String(process.env.HAPPIER_CLI_DAEMON_INTEGRATION_BOOTSTRAP_AUTH ?? '').trim().toLowerCase();
  if (!raw) return true;
  return !['0', 'false', 'no', 'off'].includes(raw);
}

export async function ensureDaemonIntegrationCredentialsForActiveServer(): Promise<DaemonIntegrationCredentialBootstrapResult> {
  const existing = await readCredentials().catch(() => null);
  if (existing?.token) {
    return { ready: true, bootstrapped: false };
  }

  if (!shouldAttemptDaemonIntegrationCredentialBootstrap()) {
    return { ready: false, reason: `missing readable credentials for active server in ${configuration.happyHomeDir}` };
  }

  if (!isLocalishServerUrl(configuration.serverUrl)) {
    return { ready: false, reason: `refusing auth bootstrap for non-local server URL (${configuration.serverUrl})` };
  }

  const secret = new Uint8Array(randomBytes(32));
  const challenge = authChallenge(secret);
  const response = await fetch(new URL('/v1/auth', configuration.serverUrl).toString(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      publicKey: encodeBase64(challenge.publicKey),
      challenge: encodeBase64(challenge.challenge),
      signature: encodeBase64(challenge.signature),
    }),
    signal: AbortSignal.timeout(5_000),
  }).catch((error) => {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : 'request failed';
    return { ok: false, status: 0, statusText: message } as const;
  });

  if (!response.ok) {
    return {
      ready: false,
      reason: `auth bootstrap failed via /v1/auth (${response.status} ${response.statusText})`,
    };
  }

  const payload = await response.json().catch(() => null) as { token?: unknown } | null;
  const token = typeof payload?.token === 'string' ? payload.token.trim() : '';
  if (!token) {
    return { ready: false, reason: 'auth bootstrap succeeded without token payload from /v1/auth' };
  }

  await writeCredentialsLegacy({ secret, token });
  const bootstrapped = await readCredentials().catch(() => null);
  if (!bootstrapped?.token) {
    return { ready: false, reason: `auth bootstrap wrote no readable credentials in ${configuration.happyHomeDir}` };
  }

  return { ready: true, bootstrapped: true };
}

export function spawnHappyLookingProcess(): { pid: number; kill: () => void } {
  const child = spawnTestProcess(
    process.execPath,
    ['-e', '/* bin/happier.mjs --started-by daemon */ setInterval(() => {}, 1_000_000)'],
  );
  const pid = child.pid;

  if (!pid) {
    throw new Error('Failed to spawn daemon integration fixture process');
  }

  return {
    pid,
    kill: () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    },
  };
}
