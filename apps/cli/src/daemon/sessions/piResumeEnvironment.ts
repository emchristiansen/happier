import { randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { CatalogAgentId } from '@/backends/types';
import type { TrackedSession } from '@/daemon/types';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { logger } from '@/ui/logger';

const PERSISTED_KEYS = ['HAPPIER_PI_PATH', 'PI_CODING_AGENT_DIR', 'SECRETSPEC_PROVIDER', 'SECRETSPEC_PROFILE', 'OP_CONNECT_HOST'] as const;
const EMPTY_ONLY_KEYS = ['OP_SERVICE_ACCOUNT_TOKEN', 'OP_CONNECT_TOKEN'] as const;
const REFUSAL = 'pi resume refused: spawn environment (HAPPIER_PI_PATH) is not available on resume';
type ResumeLogger = Pick<typeof logger, 'debug' | 'warn' | 'info'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pickEnvironment(value: unknown): Record<string, string> {
  const picked: Record<string, string> = {};
  if (!isRecord(value)) return picked;
  for (const key of PERSISTED_KEYS) {
    if (Object.hasOwn(value, key) && typeof value[key] === 'string') picked[key] = value[key];
  }
  for (const key of EMPTY_ONLY_KEYS) {
    if (Object.hasOwn(value, key) && value[key] === '') picked[key] = '';
  }
  return picked;
}

function recordFile(happyHomeDir: string, sessionId: unknown): string | null {
  if (!happyHomeDir || typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || /^PID-\d+$/.test(sessionId)) return null;
  return join(happyHomeDir, 'tmp', 'pi-resume-env', `${sessionId}.json`);
}

function expandableKeys(env: Record<string, string>): string[] {
  return Object.keys(env).filter((key) => env[key].includes('$'));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Keep the installed version-1 record shape. Resumes never replace their original spawn record. */
export function persistPiResumeEnvironment(params: Readonly<{ tracked: TrackedSession; happyHomeDir: string; logger: ResumeLogger }>): void {
  let sessionId: string | undefined;
  try {
    const tracked = params.tracked;
    if (tracked.startedBy !== 'daemon') return;
    const options = tracked.spawnOptions;
    if (options?.backendTarget?.kind !== 'builtInAgent' || options.backendTarget.agentId !== 'pi') return;
    if (typeof options.existingSessionId === 'string' && options.existingSessionId.trim()) return;
    sessionId = tracked.happySessionId?.trim();
    const environmentVariables = pickEnvironment(options.environmentVariables);
    if (!Object.keys(environmentVariables).length) return;
    const file = recordFile(params.happyHomeDir, sessionId);
    if (!file) throw new Error('session ID is not path-safe');
    const expandable = expandableKeys(environmentVariables);
    if (expandable.length) throw new Error(`a value contains "$", which a resume would expand again: ${expandable.join(', ')}`);
    const directory = dirname(file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.uid !== process.getuid?.() || (directoryStat.mode & 0o077) !== 0) {
      throw new Error(`record directory ${directory} is not a private directory owned by this user (a symlink, another owner, or group or other access)`);
    }
    const content = JSON.stringify({ version: 1, sessionId, agentId: 'pi', environmentVariables }, null, 2) + '\n';
    const temporary = join(directory, `.${sessionId}.json.${process.pid}.${randomUUID()}.tmp`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let renamed = false;
    try {
      try {
        fchmodSync(fd, 0o600);
        writeFileSync(fd, content);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(temporary, file);
      renamed = true;
      const directoryFd = openSync(directory, constants.O_RDONLY);
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } finally {
      if (!renamed) {
        try { rmSync(temporary, { force: true }); } catch {}
      }
    }
    params.logger.debug('[DAEMON RUN] pi resume environment persisted', { sessionId, file, environmentVariables });
  } catch (error) {
    try {
      params.logger.warn('[DAEMON RUN] pi resume environment not persisted; a later resume of this session will lack it', { sessionId, error: errorText(error) });
    } catch {}
  }
}

function readEnvironment(happyHomeDir: string, sessionId: string, logger: ResumeLogger): Record<string, string> | undefined {
  const file = recordFile(happyHomeDir, sessionId);
  if (!file) {
    logger.warn('[DAEMON RUN] pi resume environment not restored: session ID is not path-safe', { sessionId });
    return;
  }
  let text: string;
  try {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) throw new Error('stored record is not a regular file');
      text = readFileSync(fd, 'utf8');
    } finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    logger.warn('[DAEMON RUN] pi resume environment not restored: stored record is unreadable', { sessionId, file, error: errorText(error) });
    return;
  }
  let record: unknown;
  try { record = JSON.parse(text); } catch (error) {
    logger.warn('[DAEMON RUN] pi resume environment not restored: stored record is not JSON', { sessionId, file, error: errorText(error) });
    return;
  }
  const stored = isRecord(record) ? record.environmentVariables : undefined;
  const restored = pickEnvironment(stored);
  if (!isRecord(record) || record.version !== 1 || record.sessionId !== sessionId || record.agentId !== 'pi' || !isRecord(stored) || Object.keys(stored).length !== Object.keys(restored).length || expandableKeys(restored).length) {
    logger.warn('[DAEMON RUN] pi resume environment not restored: stored record is not a valid version 1 pi resume environment', { sessionId, file });
    return;
  }
  return restored;
}

function restoreEnvironment(params: Readonly<{ options: SpawnSessionOptions; happyHomeDir: string; sessionId: string; logger: ResumeLogger }>): SpawnSessionOptions {
  const requested = params.options.environmentVariables;
  if (Array.isArray(requested)) return params.options;
  const requestedRecord = isRecord(requested) ? requested : {};
  const requestedPath = requestedRecord.HAPPIER_PI_PATH;
  if (typeof requestedPath === 'string' && requestedPath.trim()) return params.options;
  const restored = readEnvironment(params.happyHomeDir, params.sessionId, params.logger);
  if (!restored) return params.options;
  const conflictingKeys = [...PERSISTED_KEYS, ...EMPTY_ONLY_KEYS].filter((key) => Object.hasOwn(requestedRecord, key) && (!Object.hasOwn(restored, key) || requestedRecord[key] !== restored[key]));
  if (conflictingKeys.length) {
    params.logger.warn("[DAEMON RUN] pi resume environment not restored: the caller's variables differ from the persisted ones, which are restored only as a whole", { sessionId: params.sessionId, conflictingKeys });
    return params.options;
  }
  params.logger.info('[DAEMON RUN] pi resume: restored the spawn environment persisted for this session', { sessionId: params.sessionId, restoredEnvironmentVariables: restored, callerEnvironmentVariableKeys: Object.keys(requestedRecord) });
  return { ...params.options, environmentVariables: { ...restored, ...requested } };
}

/** Called after live adoption/runtime recovery and immediately before the final environment validation. */
export function preparePiResumeEnvironment(params: Readonly<{ options: SpawnSessionOptions; catalogAgentId: CatalogAgentId; happyHomeDir: string; logger: ResumeLogger }>):
  | Readonly<{ ok: true; options: SpawnSessionOptions }>
  | Readonly<{ ok: false; errorCode: 'SPAWN_VALIDATION_FAILED'; errorMessage: string }> {
  const sessionId = typeof params.options.existingSessionId === 'string' ? params.options.existingSessionId.trim() : '';
  if (params.catalogAgentId !== 'pi' || !sessionId) return { ok: true, options: params.options };
  const options = restoreEnvironment({ ...params, sessionId });
  const env = options.environmentVariables;
  const path = env && Object.hasOwn(env, 'HAPPIER_PI_PATH') ? env.HAPPIER_PI_PATH : undefined;
  if (typeof path === 'string' && path.trim()) return { ok: true, options };
  params.logger.warn(`[DAEMON RUN] ${REFUSAL}; nothing spawned`, { sessionId, environmentVariableKeys: env ? Object.keys(env) : [] });
  return { ok: false, errorCode: 'SPAWN_VALIDATION_FAILED', errorMessage: `${REFUSAL}; start a fresh session` };
}
