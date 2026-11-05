import { userInfo } from 'node:os';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import { logger } from '@/ui/logger';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import { writeGeneratedTextAtomicallyIfChanged } from '@/utils/fs/writeGeneratedTextAtomicallyIfChanged';
import { resolveConfiguredCodexHome } from './resolveConfiguredCodexHome';
import { parseCodexVersionInfo } from '../mcp/version';

type StartupConfiguration = Readonly<{
  processEnv: NodeJS.ProcessEnv;
  cwd?: string;
  configOverrides?: readonly string[];
  versionOutput: string;
}>;

/**
 * The version only selects warm-start admission; unknown keeps the global startup lock. An
 * app-server override need not terminate a separate `--version` invocation, so discovery must
 * not become an unbounded launch prerequisite. Like the 5s local shared-control endpoint lock,
 * this is far above a healthy local reply yet small beside the 60s startup RPC budget.
 */
const CODEX_NATIVE_STARTUP_VERSION_TIMEOUT_MS = 5_000;

/**
 * How long a stopped probe may take to release its output pipe. SIGKILL cannot be ignored, so a
 * holder still present after this has left the probe's process group (for example with setsid).
 */
const CODEX_NATIVE_STARTUP_VERSION_CLEANUP_CONFIRM_MS = 2_000;

type VersionProbeCleanup = Readonly<{ outputReleased: boolean; treeCleanupFailed: boolean; groupSignalFailed: boolean }>;

/** Probe the same resolved executable (including its JS entrypoint) used for launch. */
export async function readCodexNativeStartupVersion(
  invocation: Readonly<{ command: string; args: readonly string[] }>,
  processEnv: NodeJS.ProcessEnv,
  cwd?: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!processEnv.CODEX_SQLITE_HOME || process.platform !== 'linux' || signal?.aborted) return '';
  const appServerIndex = invocation.args.indexOf('app-server');
  if (appServerIndex < 0) return '';
  return await new Promise<string>((resolveVersion) => {
    let finished = false;
    let stopping = false;
    let outputReleased = false;
    let onOutputReleased: (() => void) | null = null;
    let output = '';
    const finish = (version: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', stop);
      resolveVersion(version);
    };
    // The probe leads its own process group. A wrapper can exit while a descendant still holds the
    // output pipe; the group outlives that root, so stopping the probe still reaches the descendant.
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(invocation.command, [...invocation.args.slice(0, appServerIndex), '--version'], {
        env: processEnv, cwd, stdio: ['ignore', 'pipe', 'ignore'], detached: true, windowsHide: true,
      });
    } catch {
      resolveVersion('');
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { output += chunk; });
    child.once('error', () => { if (!stopping) finish(''); });
    // `close` waits for every holder of the output pipe, not only the root's exit.
    child.once('close', (code, exitSignal) => {
      outputReleased = true;
      onOutputReleased?.();
      if (!stopping) finish(code === 0 && exitSignal === null ? output : '');
    });
    const signalProbeGroup = (): boolean => {
      if (outputReleased || !child.pid) return true;
      try {
        process.kill(-child.pid, 'SIGKILL');
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    };
    const awaitOutputReleased = async (): Promise<boolean> => outputReleased || await new Promise<boolean>((resolveReleased) => {
      const timer = setTimeout(() => resolveReleased(false), CODEX_NATIVE_STARTUP_VERSION_CLEANUP_CONFIRM_MS);
      onOutputReleased = () => { clearTimeout(timer); resolveReleased(true); };
    });
    const cleanUpProbe = async (): Promise<VersionProbeCleanup> => {
      // While the root lives, the tree owner also reaches descendants that left its group.
      const treeCleanupFailed = await killProcessTree(child).then(() => false, () => true);
      const groupSignalFailed = !signalProbeGroup();
      return { outputReleased: await awaitOutputReleased(), treeCleanupFailed, groupSignalFailed };
    };
    // Settle only after the probe's workload is stopped and has released its output, so neither
    // expiry nor cancellation leaves a wrapper or its descendant running behind the launch.
    const stop = () => {
      if (stopping || finished) return;
      stopping = true;
      void cleanUpProbe().then((cleanup) => {
        if (!cleanup.outputReleased || cleanup.treeCleanupFailed || cleanup.groupSignalFailed) {
          try {
            logger.infoFile('[CodexNativeStartupLock] Version probe cleanup could not be verified', cleanup);
          } catch {
            // A failing diagnostic sink must not prevent settlement.
          }
        }
        finish('');
      });
    };
    const deadline = setTimeout(() => {
      stop();
      // Diagnostics never own cleanup or settlement: cleanup has already started.
      try {
        logger.infoFile('[CodexNativeStartupLock] Version discovery timed out; using global startup admission');
      } catch {
        // A failing diagnostic sink must not surface from the timer.
      }
    }, CODEX_NATIVE_STARTUP_VERSION_TIMEOUT_MS);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

async function mayExist(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
}

async function resolveStartupRoot(configuration: StartupConfiguration, sqliteHome: string): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  const home = resolveConfiguredCodexHome(configuration.processEnv);
  // Native 0.162.1 managed requirements override even -c. Uninspected config
  // can select keyring auth and enable cloud requirements without auth.json.
  // Preserve the global fallback instead of duplicating native layered config.
  const paths = [
    '/etc/codex/requirements.toml', '/etc/codex/managed_config.toml', '/etc/codex/config.toml',
    join(home, 'auth.json'), join(home, 'cloud-config-bundle-cache.json'), join(home, 'config.toml'),
  ];
  for (let cwd = resolve(configuration.cwd ?? process.cwd());;) {
    paths.push(join(cwd, '.codex', 'config.toml'));
    const parent = dirname(cwd);
    if (parent === cwd) break;
    cwd = parent;
  }
  if (configuration.configOverrides?.some(value => /^\s*cli_auth_credentials_store\s*=/u.test(value))) return null;
  if ((await Promise.all(paths.map(mayExist))).some(Boolean)) return null;
  await mkdir(sqliteHome, { recursive: true });
  return await realpath(sqliteHome);
}

async function isWarm(root: string, markerPath: string, version: string): Promise<boolean> {
  if (await readFile(markerPath, 'utf8').catch(() => null) !== `${version}\n`) return false;
  for (const name of await readdir(root)) {
    if (!/^state_\d+\.sqlite$/u.test(name)) continue;
    const file = await stat(join(root, name)).catch(() => null);
    if (file?.isFile() && file.size > 0) return true;
  }
  return false;
}

/** Exclude first native initialization/migration while leaving warm starts independent. */
export async function withCodexNativeStartupLock<TResult>(
  timeoutMs: number,
  initialize: (configOverrides: readonly string[]) => Promise<TResult>,
  signal?: AbortSignal,
  configuration?: StartupConfiguration,
): Promise<TResult> {
  signal?.throwIfAborted();
  const parsed = configuration ? parseCodexVersionInfo(configuration.versionOutput) : null;
  const version = parsed?.parsed && !parsed.prereleaseTag && /^codex(?:-cli)?\s+v?\d+\.\d+\.\d+\s*$/iu.test(configuration?.versionOutput.trim() ?? '')
    ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : null;
  const sqliteHome = configuration?.processEnv.CODEX_SQLITE_HOME;
  const callerSelectedSqliteHome = configuration?.configOverrides?.some(value => /^\s*sqlite_home\s*=/u.test(value));
  const requestedRoot = sqliteHome && isAbsolute(sqliteHome) && !callerSelectedSqliteHome ? sqliteHome : null;
  const root = configuration && version && requestedRoot ? await resolveStartupRoot(configuration, requestedRoot) : null;
  // Auth/config uncertainty retains global exclusion, but the materializer's
  // projection must still beat copied relative sqlite_home configuration.
  // Managed native requirements can override this pin, so it is not root proof.
  const launchRoot = root ?? requestedRoot;
  const overrides = [...(configuration?.configOverrides ?? []), ...(launchRoot ? [`sqlite_home=${JSON.stringify(launchRoot)}`] : [])];
  // Unresolved native config can select any SQLite root; cold/migrating starts
  // therefore share the OS-user lock. Resolved warm starts still skip admission.
  const lockPath = join(userInfo().homedir, '.happier-codex-native-startup.lock');
  const markerPath = join(root ?? userInfo().homedir, '.happier-codex-native-startup.version');
  if (root && version && await isWarm(root, markerPath, version)) {
    signal?.throwIfAborted();
    return await initialize(overrides);
  }
  return await withJsonOwnerFileLock({
    lockPath,
    // Native initialization retains its owning RPC budget; queued startup must
    // not impose a shorter competing timeout on another valid startup.
    timeoutMs: Number.POSITIVE_INFINITY,
    staleAfterMs: timeoutMs,
    errorCode: 'codex_native_startup_lock_timeout',
    signal,
    onWait: (info) => logger.infoFile('[CodexNativeStartupLock] Waiting for native startup lock', info),
  }, async () => {
    const result = await initialize(overrides);
    if (root && version) {
      await writeGeneratedTextAtomicallyIfChanged({ path: markerPath, contents: `${version}\n`, mode: 0o600 })
        .catch(() => { logger.infoFile('[CodexNativeStartupLock] Could not record successful native startup version'); });
    }
    return result;
  });
}
