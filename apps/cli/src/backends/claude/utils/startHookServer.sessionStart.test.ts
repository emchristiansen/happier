import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createClaudeToolBoundarySteering, createPostToolUseSteeringBroker, producePostToolUseSteeringOutput } from './postToolUseSteeringBroker';
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

  it('answers a PostToolUse forwarder immediately with no output when no steering is waiting', async () => {
    const broker = createPostToolUseSteeringBroker();
    const server = await startHookServer({
      onSessionHook: () => {},
      produceSessionHookOutput: (_id, data, context) => producePostToolUseSteeringOutput({ broker, data, context, expectedSessionId: 'main' }),
    });
    servers.push(server);
    const result = await Promise.race([
      runSessionForwarder({ port: server.port, hookEventName: 'PostToolUse', body: { session_id: 'main' } }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('PostToolUse hook stalled')), 2_000)),
    ]);
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('writes a waiting steering offer through the next capable PostToolUse forwarder exactly once', async () => {
    const broker = createPostToolUseSteeringBroker();
    const server = await startHookServer({
      onSessionHook: () => {},
      produceSessionHookOutput: (_id, data, context) => producePostToolUseSteeringOutput({ broker, data, context, expectedSessionId: 'main' }),
    });
    servers.push(server);
    const outcome = broker.offer({ message: 'steer now', waitMs: 10_000 });

    // Subagent and foreign-session tool boundaries never take the main session's message.
    expect(await runSessionForwarder({ port: server.port, hookEventName: 'PostToolUse', body: { session_id: 'main', agent_id: 'sub-1' } }))
      .toEqual({ code: 0, stdout: '', stderr: '' });
    expect(await runSessionForwarder({ port: server.port, hookEventName: 'PostToolUse', body: { session_id: 'other' } }))
      .toEqual({ code: 0, stdout: '', stderr: '' });

    const result = await runSessionForwarder({ port: server.port, hookEventName: 'PostToolUse', body: { session_id: 'main' } });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'steer now' },
    });
    await expect(outcome).resolves.toBe('written_to_hook_response');

    const later = await runSessionForwarder({ port: server.port, hookEventName: 'PostToolUse', body: { session_id: 'main' } });
    expect(later).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('never hands steering to an old forwarder that cannot pass hook output to Claude', async () => {
    const broker = createPostToolUseSteeringBroker();
    const server = await startHookServer({
      onSessionHook: () => {},
      produceSessionHookOutput: (_id, data, context) => producePostToolUseSteeringOutput({ broker, data, context, expectedSessionId: 'main' }),
    });
    servers.push(server);
    const outcome = broker.offer({ message: 'not for old forwarders', waitMs: 500 });
    // An old forwarder posts without advertising JSON output and discards any reply.
    const old = await postSessionHook({ port: server.port, body: { session_id: 'main', hook_event_name: 'PostToolUse' } });
    expect(old).toEqual({ status: 200, text: 'ok' });
    await expect(outcome).resolves.toBe('no_tool_boundary');
  });

  it('reports a taken message as lost when its hook response disconnects before writing, then delivers retries and later messages', async () => {
    const broker = createPostToolUseSteeringBroker();
    let disconnect: (() => void) | undefined;
    const server = await startHookServer({
      onSessionHook: () => {},
      produceSessionHookOutput: async (_id, data, context) => {
        const output = producePostToolUseSteeringOutput({ broker, data, context, expectedSessionId: 'main' });
        if (disconnect) {
          // Model Claude killing the hook command after the message was bound to this response.
          disconnect();
          await waitUntil(() => context.signal.aborted);
        }
        return output;
      },
    });
    servers.push(server);

    const first = broker.offer({ message: 'first', waitMs: 10_000 });
    const client = request({
      host: '127.0.0.1', port: server.port, path: '/hook/session-start', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-happier-hook-output': 'json-v1' },
    });
    client.on('error', () => {});
    disconnect = () => client.destroy();
    client.end(JSON.stringify({ session_id: 'main', hook_event_name: 'PostToolUse' }));
    await expect(first).resolves.toBe('hook_response_lost');
    disconnect = undefined;

    // The bound response never transfers its message; the caller's retry and a later message both arrive.
    const retry = broker.offer({ message: 'first', waitMs: 10_000 });
    const second = broker.offer({ message: 'second', waitMs: 10_000 });
    const result = await runSessionForwarder({ port: server.port, hookEventName: 'PostToolUse', body: { session_id: 'main' } });
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'first\n\nsecond' },
    });
    await expect(retry).resolves.toBe('written_to_hook_response');
    await expect(second).resolves.toBe('written_to_hook_response');
  });

  it('does not bind steering to a hook response whose forwarder already disconnected', async () => {
    const broker = createPostToolUseSteeringBroker();
    let release!: () => void;
    const released = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    let signal: AbortSignal | undefined;
    const server = await startHookServer({
      onSessionHook: () => {},
      produceSessionHookOutput: async (_id, data, context) => {
        signal = context.signal;
        await released;
        return producePostToolUseSteeringOutput({ broker, data, context, expectedSessionId: 'main' });
      },
    });
    servers.push(server);
    const outcome = broker.offer({ message: 'survives', waitMs: 10_000 });
    const client = request({
      host: '127.0.0.1', port: server.port, path: '/hook/session-start', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-happier-hook-output': 'json-v1' },
    });
    client.on('error', () => {});
    client.end(JSON.stringify({ session_id: 'main', hook_event_name: 'PostToolUse' }));
    await waitUntil(() => signal !== undefined);
    client.destroy();
    await waitUntil(() => signal?.aborted === true);
    release();

    const result = await runSessionForwarder({ port: server.port, hookEventName: 'PostToolUse', body: { session_id: 'main' } });
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toBe('survives');
    await expect(outcome).resolves.toBe('written_to_hook_response');
  });

  it('withholds steering while the native primary identity is unknown, then delivers to the established primary', async () => {
    let expectedSessionId: string | null = null;
    const steering = createClaudeToolBoundarySteering({ readExpectedSessionId: () => expectedSessionId });
    const server = await startHookServer({ onSessionHook: () => {}, produceSessionHookOutput: steering.produceSessionHookOutput });
    servers.push(server);
    const fire = (body: Record<string, unknown>) => runSessionForwarder({ port: server.port, hookEventName: 'PostToolUse', body });
    const none = { code: 0, stdout: '', stderr: '' };

    // First start: identity not yet established; a primary-looking hook from any session takes nothing.
    const first = steering.steerAtToolBoundary({ message: 'for main', waitMs: 10_000 });
    expect(await fire({ session_id: 'foreign' })).toEqual(none);
    expect(await fire({ session_id: 'main' })).toEqual(none);

    expectedSessionId = 'main';
    expect(await fire({ session_id: 'foreign' })).toEqual(none);
    expect(await fire({ session_id: 'main', agent_id: 'sub-1' })).toEqual(none);
    expect(JSON.parse((await fire({ session_id: 'main' })).stdout).hookSpecificOutput.additionalContext).toBe('for main');
    await expect(first).resolves.toBe('written_to_hook_response');

    // Fork preparation clears identity; the old and new sessions both wait for the new identity.
    expectedSessionId = null;
    const second = steering.steerAtToolBoundary({ message: 'for fork', waitMs: 10_000 });
    expect(await fire({ session_id: 'main' })).toEqual(none);
    expect(await fire({ session_id: 'forked' })).toEqual(none);
    expectedSessionId = 'forked';
    expect(await fire({ session_id: 'main' })).toEqual(none);
    expect(JSON.parse((await fire({ session_id: 'forked' })).stdout).hookSpecificOutput.additionalContext).toBe('for fork');
    await expect(second).resolves.toBe('written_to_hook_response');
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
