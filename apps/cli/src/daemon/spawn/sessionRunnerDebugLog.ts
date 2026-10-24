import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Per-session runner debug log switch.
 *
 * A marker file under the daemon's state directory names one session. When the daemon spawns that
 * session's runner (a resume or respawn of an existing session), it adds HAPPIER_LOG_LEVEL=debug to
 * that runner's environment only. The daemon reads the marker at every spawn, so setting or clearing
 * it takes effect at the session's next runner start without restarting the daemon, and no other
 * session's level changes.
 */
export const SESSION_RUNNER_DEBUG_LOG_DIRNAME = 'session-runner-debug-log';

const SESSION_ID_SEGMENT = /^[A-Za-z0-9_-]+$/;

export type SessionRunnerDebugLogLocation = Readonly<{
  /** The daemon lifecycle directory: the directory holding the daemon state file. */
  daemonStateDir: string;
  sessionId: string;
}>;

function resolveMarkerPath(location: SessionRunnerDebugLogLocation): string | null {
  if (!SESSION_ID_SEGMENT.test(location.sessionId)) return null;
  return join(location.daemonStateDir, SESSION_RUNNER_DEBUG_LOG_DIRNAME, location.sessionId);
}

export async function writeSessionRunnerDebugLog(
  params: SessionRunnerDebugLogLocation & Readonly<{ enabled: boolean }>,
): Promise<void> {
  const markerPath = resolveMarkerPath(params);
  if (!markerPath) {
    throw new Error('Session id must be a single path segment of letters, digits, "-" or "_".');
  }
  if (!params.enabled) {
    await rm(markerPath, { force: true });
    return;
  }
  await mkdir(join(params.daemonStateDir, SESSION_RUNNER_DEBUG_LOG_DIRNAME), { recursive: true, mode: 0o700 });
  await writeFile(markerPath, `${JSON.stringify({ logLevel: 'debug', setAt: new Date().toISOString() })}\n`, {
    mode: 0o600,
  });
}

/**
 * Whether the switch is on. A missing marker (or a missing switch or state directory) means off; any other
 * failure to read it, or a marker that is not a regular file, is an error the caller decides how to report.
 */
export async function readSessionRunnerDebugLog(location: SessionRunnerDebugLogLocation): Promise<boolean> {
  const markerPath = resolveMarkerPath(location);
  if (!markerPath) return false;
  let markerStats: Awaited<ReturnType<typeof stat>>;
  try {
    markerStats = await stat(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false;
    throw error;
  }
  if (!markerStats.isFile()) {
    throw new Error(`Session runner debug log marker is not a regular file: ${markerPath}`);
  }
  return true;
}

/** The runner environment additions for one session's spawn: the debug level when its switch is on. */
export async function resolveSessionRunnerDebugLogEnv(
  location: SessionRunnerDebugLogLocation,
): Promise<Readonly<{ HAPPIER_LOG_LEVEL?: 'debug' }>> {
  return await readSessionRunnerDebugLog(location) ? { HAPPIER_LOG_LEVEL: 'debug' } : {};
}

/**
 * The switch as a spawn reads it. A diagnostics switch never fails a spawn: if locating or reading the
 * marker fails in any way, the switch is off for this spawn and the failure is reported once through
 * `warn`, with the error.
 */
export async function resolveSessionRunnerDebugLogEnvForSpawn(params: Readonly<{
  sessionId: string;
  /** Called inside the guard, because deriving the directory is part of reading the switch. */
  resolveDaemonStateDir: () => string;
  warn: (message: string, details: Readonly<{ sessionId: string; error: unknown }>) => void;
}>): Promise<Readonly<{ HAPPIER_LOG_LEVEL?: 'debug' }>> {
  try {
    return await resolveSessionRunnerDebugLogEnv({
      daemonStateDir: params.resolveDaemonStateDir(),
      sessionId: params.sessionId,
    });
  } catch (error) {
    params.warn(
      '[DAEMON RUN] Could not read the session runner debug log switch; spawning this runner at its default level',
      { sessionId: params.sessionId, error },
    );
    return {};
  }
}
