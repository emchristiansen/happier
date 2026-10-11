import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { TrackedSession } from '@/daemon/types';
import { validateEnvVarRecordStrict } from '@/terminal/runtime/envVarSanitization';
import { resolveSpawnChildEnvironment } from '@/daemon/spawn/resolveSpawnChildEnvironment';
import { persistPiResumeEnvironment, preparePiResumeEnvironment } from './piResumeEnvironment';

const roots: string[] = [];
const missingPaths: (Record<string, string> | undefined)[] = [undefined, {}, { HAPPIER_PI_PATH: ' ' }];
const invalidMaps: Record<string, string>[] = [{ HAPPIER_PI_PATH: '/bad/${EXPANSION}' }, { HAPPIER_PI_PATH: '/stored/pi', UNKNOWN: 'invalid' }, { HAPPIER_PI_PATH: '/stored/pi', OP_CONNECT_TOKEN: 'nonempty' }];
const logger = { debug: vi.fn(), warn: vi.fn(), info: vi.fn() };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); });
function home() { const root = mkdtempSync(join(tmpdir(), 'pi-resume-source-')); roots.push(root); return root; }
function recordPath(root: string, id = 'synthetic-session') { return join(root, 'tmp', 'pi-resume-env', `${id}.json`); }
function tracked(environmentVariables: Record<string, string>, existingSessionId?: string): TrackedSession {
  return { pid: 1, startedBy: 'daemon', happySessionId: 'synthetic-session', spawnOptions: { directory: '/synthetic', backendTarget: { kind: 'builtInAgent', agentId: 'pi' }, environmentVariables, ...(existingSessionId ? { existingSessionId } : {}) } };
}
function resume(root: string, environmentVariables?: Record<string, string>) {
  return preparePiResumeEnvironment({ happyHomeDir: root, logger, catalogAgentId: 'pi', options: { directory: '/synthetic', backendTarget: { kind: 'builtInAgent', agentId: 'pi' }, existingSessionId: 'synthetic-session', ...(environmentVariables ? { environmentVariables } : {}) } });
}
function oldRecord(root: string, environmentVariables: Record<string, string>) {
  mkdirSync(join(root, 'tmp', 'pi-resume-env'), { recursive: true, mode: 0o700 });
  // Installed patch-happier-pi-resume-env.mjs writes exactly this version-1 shape.
  writeFileSync(recordPath(root), JSON.stringify({ version: 1, sessionId: 'synthetic-session', agentId: 'pi', environmentVariables }, null, 2) + '\n', { mode: 0o600 });
}

describe('Pi resume environment custody', () => {
  it('writes a private version-1 record and restores only the installed environment subset', () => {
    const root = home();
    persistPiResumeEnvironment({ happyHomeDir: root, logger, tracked: tracked({ HAPPIER_PI_PATH: '/synthetic/pi', PI_CODING_AGENT_DIR: '/synthetic/config', SECRETSPEC_PROFILE: 'synthetic-profile', OP_SERVICE_ACCOUNT_TOKEN: '', OP_CONNECT_TOKEN: 'synthetic-value-never-stored', UNRELATED: 'never-stored' }) });
    const content = JSON.parse(readFileSync(recordPath(root), 'utf8'));
    expect(content).toEqual({ version: 1, sessionId: 'synthetic-session', agentId: 'pi', environmentVariables: { HAPPIER_PI_PATH: '/synthetic/pi', PI_CODING_AGENT_DIR: '/synthetic/config', SECRETSPEC_PROFILE: 'synthetic-profile', OP_SERVICE_ACCOUNT_TOKEN: '' } });
    expect(lstatSync(recordPath(root)).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(root, 'tmp', 'pi-resume-env')).mode & 0o777).toBe(0o700);
    expect(resume(root)).toMatchObject({ ok: true, options: { environmentVariables: content.environmentVariables } });
  });

  it('reads installed version-1 records without rewriting them', () => {
    const root = home(); oldRecord(root, { HAPPIER_PI_PATH: '/old-writer/pi', OP_CONNECT_TOKEN: '' });
    const before = readFileSync(recordPath(root), 'utf8');
    expect(resume(root)).toMatchObject({ ok: true, options: { environmentVariables: { HAPPIER_PI_PATH: '/old-writer/pi', OP_CONNECT_TOKEN: '' } } });
    persistPiResumeEnvironment({ happyHomeDir: root, logger, tracked: tracked({ HAPPIER_PI_PATH: '/different/pi' }, 'synthetic-session') });
    expect(readFileSync(recordPath(root), 'utf8')).toBe(before);
  });

  it.each(missingPaths)('refuses a resume without a caller path or valid record', (env) => {
    expect(resume(home(), env)).toMatchObject({ ok: false, errorCode: 'SPAWN_VALIDATION_FAILED' });
  });

  it('restores as one unit while preserving matching caller values and unrelated values', () => {
    const root = home(); oldRecord(root, { HAPPIER_PI_PATH: '/stored/pi', PI_CODING_AGENT_DIR: '/stored/config', OP_CONNECT_TOKEN: '' });
    expect(resume(root, { PI_CODING_AGENT_DIR: '/stored/config', EXTRA: 'caller' })).toMatchObject({ ok: true, options: { environmentVariables: { HAPPIER_PI_PATH: '/stored/pi', PI_CODING_AGENT_DIR: '/stored/config', OP_CONNECT_TOKEN: '', EXTRA: 'caller' } } });
    expect(resume(root, { PI_CODING_AGENT_DIR: '/other/config' })).toMatchObject({ ok: false });
    expect(resume(root, { HAPPIER_PI_PATH: '' })).toMatchObject({ ok: false });
  });

  it('does not consult a record when the caller supplies its own nonblank path', () => {
    const root = home(); oldRecord(root, { HAPPIER_PI_PATH: '/stored/pi' });
    const options = { HAPPIER_PI_PATH: '/caller/pi', PI_CODING_AGENT_DIR: '/caller/config' };
    expect(resume(root, options)).toMatchObject({ ok: true, options: { environmentVariables: options } });
  });

  it.each(invalidMaps)('rejects invalid or expandable stored maps', (env) => {
    const root = home(); oldRecord(root, env); expect(resume(root)).toMatchObject({ ok: false });
  });

  it('does not persist expandable maps, placeholder IDs, or nonfresh/nonbuilt-in sessions', () => {
    const root = home();
    const inputs: TrackedSession[] = [tracked({ HAPPIER_PI_PATH: '/bad/${EXPANSION}' }), { ...tracked({ HAPPIER_PI_PATH: '/synthetic/pi' }), happySessionId: 'PID-123' }, { ...tracked({ HAPPIER_PI_PATH: '/synthetic/pi' }), startedBy: 'terminal' }, tracked({ HAPPIER_PI_PATH: '/synthetic/pi' }, 'old-session')];
    for (const session of inputs) persistPiResumeEnvironment({ happyHomeDir: root, logger, tracked: session });
    expect(() => lstatSync(recordPath(root))).toThrow();
  });

  it('refuses unsafe record identities and symlink records', () => {
    const root = home(); oldRecord(root, { HAPPIER_PI_PATH: '/stored/pi' });
    const path = recordPath(root); const other = join(root, 'other.json');
    writeFileSync(other, readFileSync(path)); rmSync(path); symlinkSync(other, path);
    expect(resume(root)).toMatchObject({ ok: false });
    expect(preparePiResumeEnvironment({ happyHomeDir: root, logger, catalogAgentId: 'pi', options: { directory: '/synthetic', existingSessionId: '../unsafe' } })).toMatchObject({ ok: false });
  });

  it('refuses to write into a nonprivate directory', () => {
    const root = home(); oldRecord(root, { HAPPIER_PI_PATH: '/old/pi' });
    chmodSync(join(root, 'tmp', 'pi-resume-env'), 0o755);
    persistPiResumeEnvironment({ happyHomeDir: root, logger, tracked: tracked({ HAPPIER_PI_PATH: '/new/pi' }) });
    expect(JSON.parse(readFileSync(recordPath(root), 'utf8')).environmentVariables.HAPPIER_PI_PATH).toBe('/old/pi');
  });

  it('leaves fresh spawns, other agents and configured ACP targets unchanged', () => {
    const root = home();
    const cases: { options: SpawnSessionOptions; catalogAgentId: 'pi' | 'codex' | 'customAcp' }[] = [
      { options: { directory: '/synthetic', backendTarget: { kind: 'builtInAgent', agentId: 'pi' } }, catalogAgentId: 'pi' },
      { options: { directory: '/synthetic', existingSessionId: 'old', backendTarget: { kind: 'configuredAcpBackend', backendId: 'pi' } }, catalogAgentId: 'customAcp' },
      { options: { directory: '/synthetic', existingSessionId: 'old', backendTarget: { kind: 'builtInAgent', agentId: 'codex' } }, catalogAgentId: 'codex' },
    ];
    for (const { options, catalogAgentId } of cases) {
      expect(preparePiResumeEnvironment({ happyHomeDir: root, logger, catalogAgentId, options })).toEqual({ ok: true, options });
    }
  });
});


it('restores before strict validation and carries the stored values into the child environment', async () => {
  const root = home();
  oldRecord(root, { HAPPIER_PI_PATH: '/stored/pi', PI_CODING_AGENT_DIR: '/stored/config', OP_CONNECT_TOKEN: '' });
  const prepared = resume(root);
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) throw new Error('Expected synthetic restore to succeed');
  const validated = validateEnvVarRecordStrict(prepared.options.environmentVariables);
  expect(validated.ok).toBe(true);
  if (!validated.ok) throw new Error('Expected stored environment to validate');
  const child = await resolveSpawnChildEnvironment({
    options: prepared.options, profileEnvironmentVariables: validated.env, daemonSpawnHooks: null,
    processEnv: { HAPPIER_PI_PATH: '/ambient/pi', OP_CONNECT_TOKEN: 'synthetic-ambient' },
    logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
  });
  expect(child).toMatchObject({ ok: true, extraEnvForChild: { HAPPIER_PI_PATH: '/stored/pi', PI_CODING_AGENT_DIR: '/stored/config', OP_CONNECT_TOKEN: '' } });
});
