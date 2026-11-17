import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createPostToolUseRendezvous } from './postToolUseRendezvous';
import { startHookServer } from './startHookServer';

async function postSessionHook(params: {
  port: number;
  secret?: string;
  body: unknown;
}): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${params.port}/hook/session-start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(params.secret ? { 'x-happier-hook-secret': params.secret } : {}),
    },
    body: JSON.stringify(params.body),
  });
  return { status: res.status, text: await res.text() };
}

async function runSessionForwarder(params: {
  port: number;
  hookEventName: string;
  secretFile?: string;
  body: unknown;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const scriptPath = resolve(process.cwd(), 'scripts', 'session_hook_forwarder.cjs');
  const args = [scriptPath, String(params.port), params.hookEventName];
  if (params.secretFile) {
    args.push('--secret-file', params.secretFile);
  }
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(params.body));
  });
}

function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const startedAt = Date.now();
    const tick = (): void => {
      if (predicate()) {
        resolvePromise();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        rejectPromise(new Error('waitUntil timed out'));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe('startHookServer (/hook/session-start authentication, A5-MED-2)', () => {
  const servers: Array<{ stop: () => void }> = [];

  afterEach(() => {
    for (const server of servers.splice(0, servers.length)) {
      server.stop();
    }
  });

  it('rejects session hooks without the secret header when a secret is configured', async () => {
    const onSessionHook = vi.fn();
    const server = await startHookServer({
      onSessionHook,
      permissionHookSecret: 'hook-secret-1',
    });
    servers.push(server);

    const missing = await postSessionHook({
      port: server.port,
      body: { session_id: 'spoofed', hook_event_name: 'SessionStart', transcript_path: '/tmp/evil.jsonl' },
    });
    expect(missing.status).toBe(403);

    const wrong = await postSessionHook({
      port: server.port,
      secret: 'not-the-secret',
      body: { session_id: 'spoofed', hook_event_name: 'SessionStart' },
    });
    expect(wrong.status).toBe(403);

    expect(onSessionHook).not.toHaveBeenCalled();
  });

  it('accepts session hooks carrying the configured secret header', async () => {
    const onSessionHook = vi.fn();
    const server = await startHookServer({
      onSessionHook,
      permissionHookSecret: 'hook-secret-1',
    });
    servers.push(server);

    const ok = await postSessionHook({
      port: server.port,
      secret: 'hook-secret-1',
      body: { session_id: 'real-session', hook_event_name: 'SessionStart' },
    });
    expect(ok.status).toBe(200);
    expect(onSessionHook).toHaveBeenCalledWith('real-session', expect.objectContaining({ session_id: 'real-session' }));
  });

  it('keeps accepting unauthenticated session hooks when no secret is configured (back-compat)', async () => {
    const onSessionHook = vi.fn();
    const server = await startHookServer({ onSessionHook });
    servers.push(server);

    const ok = await postSessionHook({
      port: server.port,
      body: { session_id: 'legacy', hook_event_name: 'SessionStart' },
    });
    expect(ok.status).toBe(200);
    expect(onSessionHook).toHaveBeenCalledWith('legacy', expect.anything());
  });

  it('does not forward incidental observer return values as Claude output', async () => {
    const observed: unknown[] = [];
    const server = await startHookServer({ onSessionHook: (_id, data) => ({ count: observed.push(data) }) });
    servers.push(server);
    const result = await runSessionForwarder({ port: server.port, hookEventName: 'Stop', body: { session_id: 'test' } });
    expect(observed).toHaveLength(1);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('cancels a pending producer when its HTTP client disconnects, but not when its request body ends', async () => {
    const rendezvous = createPostToolUseRendezvous();
    let signal: AbortSignal | undefined;
    const server = await startHookServer({
      onSessionHook: () => {},
      produceSessionHookOutput: async (_id: string, _data: unknown, context: { signal: AbortSignal }) => {
        signal = context?.signal;
        if (!signal) return;
        const message = await rendezvous.wait(signal);
        return message ? { message } : undefined;
      },
    });
    servers.push(server);
    const client = request({ host: '127.0.0.1', port: server.port, path: '/hook/session-start', method: 'POST' });
    client.on('error', () => {});
    client.end(JSON.stringify({ session_id: 'disconnect', hook_event_name: 'PostToolUse' }));
    try {
      await waitUntil(() => signal !== undefined);
      expect(signal?.aborted).toBe(false);
      expect(rendezvous.current()).toBeDefined();
      client.destroy();
      await waitUntil(() => signal?.aborted === true);
      expect(rendezvous.current()).toBeUndefined();
    } finally {
      client.destroy();
    }

    const response = postSessionHook({ port: server.port, body: { session_id: 'live', hook_event_name: 'PostToolUse' } });
    await waitUntil(() => rendezvous.current() !== undefined);
    expect(rendezvous.current()?.offer('next message')).toBe(true);
    expect(await response).toEqual({ status: 200, text: JSON.stringify({ message: 'next message' }) });
  });

  it('does not transfer an expired forwarder response to a later PostToolUse forwarder', async () => {
    const rendezvous = createPostToolUseRendezvous();
    const server = await startHookServer({
      onSessionHook: () => {},
      produceSessionHookOutput: async (_id, data, { signal }) => {
        if (data.hook_event_name !== 'PostToolUse') return;
        const message = await rendezvous.wait(signal);
        return message === undefined ? undefined : {
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message },
        };
      },
    });
    servers.push(server);
    const child = spawn(process.execPath, [resolve(process.cwd(), 'scripts', 'session_hook_forwarder.cjs'), String(server.port), 'PostToolUse'], {
      cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolvePromise({ code, signal }));
    });
    child.stdin.end(JSON.stringify({ session_id: 'expired' }));
    try {
      await waitUntil(() => rendezvous.current() !== undefined);
      const expired = rendezvous.current()!;
      // Model Claude timing out and terminating its hook subprocess.
      child.kill();
      expect(await closed).toEqual({ code: null, signal: 'SIGTERM' });
      await waitUntil(() => rendezvous.current() === undefined);
      expect(expired.offer('too late')).toBe(false);

      const next = runSessionForwarder({ port: server.port, hookEventName: 'PostToolUse', body: { session_id: 'next' } });
      await waitUntil(() => rendezvous.current() !== undefined);
      expect(expired.offer('stale again')).toBe(false);
      expect(rendezvous.current()?.offer('fresh message')).toBe(true);
      const result = await next;
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'fresh message' },
      });
      expect(rendezvous.current()).toBeUndefined();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });

  it('returns structured hook output from an asynchronous callback through the executable', async () => {
    const output = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Context for Claude' } };
    const observer = vi.fn();
    const server = await startHookServer({ onSessionHook: observer, produceSessionHookOutput: async () => output, permissionHookSecret: 'secret' });
    servers.push(server);
    const dir = mkdtempSync(join(tmpdir(), 'happier-session-hook-output-'));
    const secretFile = join(dir, 'hook-secret');
    writeFileSync(secretFile, 'secret', { mode: 0o600 });
    const result = await runSessionForwarder({ port: server.port, hookEventName: 'UserPromptSubmit', secretFile, body: { session_id: 'test' } });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(observer).toHaveBeenCalledWith('test', expect.objectContaining({ hook_event_name: 'UserPromptSubmit' }));
    expect(JSON.parse(result.stdout)).toEqual(output);
  });

  it('session forwarder reads --secret-file and authenticates against the server', async () => {
    const onSessionHook = vi.fn();
    const server = await startHookServer({
      onSessionHook,
      permissionHookSecret: 'forwarded-secret',
    });
    servers.push(server);

    const dir = mkdtempSync(join(tmpdir(), 'happier-session-hook-secret-'));
    const secretFile = join(dir, 'hook-secret');
    writeFileSync(secretFile, 'forwarded-secret\n', { mode: 0o600 });

    const result = await runSessionForwarder({
      port: server.port,
      hookEventName: 'SessionStart',
      secretFile,
      body: { session_id: 'via-forwarder' },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    await waitUntil(() => onSessionHook.mock.calls.length === 1);
    expect(onSessionHook).toHaveBeenCalledWith('via-forwarder', expect.objectContaining({
      hook_event_name: 'SessionStart',
    }));
  });

  it('does not wait for an observer promise before returning hook output', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const server = await startHookServer({ onSessionHook: () => pending });
    servers.push(server);
    try {
      const result = await Promise.race([
        runSessionForwarder({ port: server.port, hookEventName: 'Stop', body: { session_id: 'test' } }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('observer blocked hook')), 1000)),
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
    } finally {
      release();
    }
  });

  it('reports an asynchronous output producer failure without emitting hook output', async () => {
    const server = await startHookServer({ onSessionHook: () => {}, produceSessionHookOutput: async () => { throw new Error('callback failed'); } });
    servers.push(server);
    const result = await runSessionForwarder({ port: server.port, hookEventName: 'Stop', body: { session_id: 'test' } });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('500');
  });

  it('makes non-2xx hook delivery visible through a nonzero command exit', async () => {
    const server = await startHookServer({
      onSessionHook: vi.fn(),
      permissionHookSecret: 'expected-secret',
    });
    servers.push(server);

    const result = await runSessionForwarder({
      port: server.port,
      hookEventName: 'PostToolUse',
      body: { session_id: 'rejected-hook' },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('403');
    expect(result.stderr).not.toContain('expected-secret');
    expect(result.stderr).not.toContain('rejected-hook');
  });

  it('makes hook transport failure visible through a nonzero command exit', async () => {
    const server = await startHookServer({ onSessionHook: vi.fn() });
    const port = server.port;
    server.stop();

    const result = await runSessionForwarder({
      port,
      hookEventName: 'PostToolUse',
      body: { session_id: 'unreachable-hook' },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('ECONNREFUSED');
    expect(result.stderr).not.toContain('unreachable-hook');
  });

  it('reports an unreadable secret file without revealing its path or hook payload', async () => {
    const server = await startHookServer({ onSessionHook: vi.fn(), permissionHookSecret: 'expected-secret' });
    servers.push(server);
    const secretFile = join(mkdtempSync(join(tmpdir(), 'happier-missing-hook-secret-')), 'private-secret');
    const result = await runSessionForwarder({
      port: server.port,
      hookEventName: 'Stop',
      secretFile,
      body: { session_id: 'private-session' },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('ENOENT');
    expect(result.stderr).toContain('403');
    expect(result.stderr).not.toContain(secretFile);
    expect(result.stderr).not.toContain('expected-secret');
    expect(result.stderr).not.toContain('private-session');
  });
});
