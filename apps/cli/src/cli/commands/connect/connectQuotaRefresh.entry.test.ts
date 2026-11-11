import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { projectPath } from '@/projectPath';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

/**
 * `happier connect quota-refresh` from the CLI's normal entry (src/index.ts), with its own stored
 * credential, the real ApiClient and axios, against a synthetic local server. Nothing is stubbed in
 * process, so the account-mode reader the command actually uses is the one under test.
 */
const CLI_CHILD_TIMEOUT_MS = 60_000;

type Recorded = Readonly<{ method: string; path: string; authorization: string | undefined }>;
type ModeAnswer = Readonly<{ status: number; body: unknown }>;

function startServer(mode: ModeAnswer): Promise<Readonly<{ server: Server; url: string; requests: Recorded[] }>> {
  const requests: Recorded[] = [];
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://local').pathname;
    requests.push({ method: req.method ?? '', path, authorization: req.headers.authorization });
    req.resume();
    if (req.method === 'GET' && path === '/v1/account/encryption') return send(res, mode.status, mode.body);
    if (req.method === 'GET' && path === '/v3/connect/openai-codex/profiles/work/credential/health') {
      return send(res, 200, { profileId: 'work', status: 'connected', health: null });
    }
    const quota = path.match(/^\/(v[23])\/connect\/openai-codex\/profiles\/work\/quotas(\/refresh)?$/);
    if (quota && req.method === 'POST' && quota[2]) return send(res, 200, { success: true });
    if (quota && req.method === 'GET' && !quota[2]) {
      const metadata = { fetchedAt: 1_000, staleAfterMs: 60_000, status: 'ok', refreshRequestedAt: 2_000 };
      return quota[1] === 'v2'
        ? send(res, 200, { sealed: { format: 'account_scoped_v1', ciphertext: 'c2VhbGVk' }, metadata })
        : send(res, 200, {
          content: { t: 'plain', v: { v: 1, serviceId: 'openai-codex', profileId: 'work', fetchedAt: 1_000, staleAfterMs: 60_000, planLabel: null, accountLabel: null, meters: [] } },
          metadata,
        });
    }
    return send(res, 404, { message: `Route ${req.method}:${path} not found`, error: 'Not Found', statusCode: 404 });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, requests });
    });
  });
}

function runCli(args: readonly string[], env: NodeJS.ProcessEnv): Promise<Readonly<{ code: number | null; stdout: string; stderr: string }>> {
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
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe('connect quota-refresh from the normal CLI entry', () => {
  let homeDir: string;
  let server: Server | null = null;

  beforeEach(() => {
    homeDir = createTempDirSync('happier-cli-quota-refresh-entry-');
    mkdirSync(join(homeDir, 'servers', 'quota-test'), { recursive: true });
    writeFileSync(join(homeDir, 'servers', 'quota-test', 'access.key'), JSON.stringify({ token: 'own-cli-token', encryption: null }));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
    removeTempDirSync(homeDir);
  });

  async function run(mode: ModeAnswer) {
    const started = await startServer(mode);
    server = started.server;
    const result = await runCli(['connect', 'quota-refresh', '--service', 'openai-codex', '--profile', 'work', '--json'], {
      ...process.env,
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_ACTIVE_SERVER_ID: 'quota-test',
      HAPPIER_SERVER_URL: started.url,
      HAPPIER_WEBAPP_URL: started.url,
      HAPPIER_CLI_UPDATE_CHECK: '0',
      HAPPIER_CLI_RUNTIME_DISABLE: '1',
      DEBUG: undefined,
    });
    return { ...result, requests: started.requests };
  }

  it('refuses, writing nothing, when the mode endpoint answers a generic 404', async () => {
    const result = await run({ status: 404, body: { message: 'Route GET:/v1/account/encryption not found', error: 'Not Found', statusCode: 404 } });
    expect(result.code, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toMatchObject({
      outcome: 'refused', reason: 'account_encryption_mode_unknown',
    });
    expect(result.requests.filter((request) => request.method === 'POST')).toEqual([]);
  }, CLI_CHILD_TIMEOUT_MS + 10_000);

  it('control: a confirmed e2ee account requests through V2 with the CLI\'s own credential', async () => {
    const result = await run({ status: 200, body: { mode: 'e2ee', updatedAt: 1 } });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toMatchObject({
      outcome: 'requested', accountEncryptionMode: 'e2ee', state: 'pending',
    });
    const posts = result.requests.filter((request) => request.method === 'POST');
    expect(posts).toEqual([{ method: 'POST', path: '/v2/connect/openai-codex/profiles/work/quotas/refresh', authorization: 'Bearer own-cli-token' }]);
  }, CLI_CHILD_TIMEOUT_MS + 10_000);

  it('control: a confirmed plain account requests through V3', async () => {
    const result = await run({ status: 200, body: { mode: 'plain', updatedAt: 1 } });
    expect(result.code, result.stderr).toBe(0);
    expect(result.requests.filter((request) => request.method === 'POST').map((request) => request.path))
      .toEqual(['/v3/connect/openai-codex/profiles/work/quotas/refresh']);
  }, CLI_CHILD_TIMEOUT_MS + 10_000);
});
