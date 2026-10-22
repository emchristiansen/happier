import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { projectPath } from '@/projectPath';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

const CLI_CHILD_TIMEOUT_MS = 60_000;

type ChildResult = Readonly<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;

function runCli(args: readonly string[], env: NodeJS.ProcessEnv): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(projectPath(), 'src', 'index.ts'), ...args], {
      cwd: projectPath(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI child timed out after ${CLI_CHILD_TIMEOUT_MS}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, CLI_CHILD_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

describe('non-daemon CLI start', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = createTempDirSync('happier-cli-start-no-prune-');
  });

  afterEach(() => {
    removeTempDirSync(homeDir);
  });

  it('removes nothing from the logs dir when `session send` starts and exits', async () => {
    const logsDir = join(homeDir, 'logs');
    mkdirSync(join(logsDir, 'session-exit'), { recursive: true });
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const fixtures: string[] = [];
    // 250 > DEFAULT_SESSION_LOG_KEEP_COUNT (200); pids above every platform's pid ceiling are dead.
    for (let index = 0; index < 250; index += 1) {
      const name = `2026-01-01-10-${String(Math.floor(index / 60)).padStart(2, '0')}-${String(index % 60).padStart(2, '0')}-pid-${4_200_000 + index}.log`;
      writeFileSync(join(logsDir, name), `old session ${index}\n`, 'utf8');
      utimesSync(join(logsDir, name), thirtyDaysAgo, thirtyDaysAgo);
      fixtures.push(name);
    }

    const result = await runCli(['session', 'send', 'no-such-session', 'hello', '--json'], {
      ...process.env,
      HAPPIER_HOME_DIR: homeDir,
      // Unreachable stub server: `session send` must stop at the missing-credentials check.
      HAPPIER_SERVER_URL: 'http://127.0.0.1:9',
      HAPPIER_WEBAPP_URL: 'http://127.0.0.1:9',
      HAPPIER_CLI_UPDATE_CHECK: '0',
      HAPPIER_CLI_RUNTIME_DISABLE: '1',
      HAPPIER_SESSION_LOG_KEEP_COUNT: undefined,
      HAPPIER_CRASHED_SESSION_LOG_KEEP_COUNT: undefined,
      HAPPIER_SESSION_LOG_MIN_AGE_DAYS: undefined,
      DEBUG: undefined,
    });

    // The CLI really started against this home: it answered and created its server-scoped state.
    expect(result.stdout, result.stderr).toContain('not_authenticated');
    expect(existsSync(join(homeDir, 'servers'))).toBe(true);
    const entries = readdirSync(logsDir);
    for (const fixture of fixtures) {
      expect(entries).toContain(fixture);
    }
  });
});
