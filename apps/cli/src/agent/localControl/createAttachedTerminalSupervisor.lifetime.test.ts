import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import { isPidAlive, waitForProcessExit } from '@/testkit/process/spawn';
import { createAttachedTerminalSupervisor } from './createAttachedTerminalSupervisor';

describe('native same-pane controller lifetime', () => {
  it('forced Detach retires the native descendants, preserving the controller and unrelated host', async () => {
    if (process.platform === 'win32') return;
    const directory = await mkdtemp(join(tmpdir(), 'happier-native-forced-detach-'));
    const readyPath = join(directory, 'ready.json');
    const descendant = 'process.on("SIGTERM", () => {}); process.send(process.pid); setInterval(() => {}, 1000);';
    const provider = `
      process.on('SIGINT', () => {});
      const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.once('message', pid => require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ provider: process.pid, descendant: pid })));
      setInterval(() => {}, 1000);
    `;
    const onExit = vi.fn();
    const supervisor = createAttachedTerminalSupervisor({
      resolveInvocation: () => ({ command: process.execPath, args: ['-e', provider] }),
      env: { PATH: process.env.PATH, HOME: directory, HAPPIER_HOME_DIR: directory },
      onExit,
    });
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    let tree: { provider: number; descendant: number } | undefined;
    try {
      expect(await supervisor.attach(null)).toBe(true);
      await vi.waitFor(async () => { tree = JSON.parse(await readFile(readyPath, 'utf8')); }, { timeout: 3_000 });
      await supervisor.detach();
      expect(supervisor.isAttached()).toBe(false);
      await expect(waitForProcessExit(tree!.provider, { timeoutMs: 3_000 })).resolves.toBe(true);
      await expect(waitForProcessExit(tree!.descendant, { timeoutMs: 3_000 })).resolves.toBe(true);
      expect(onExit).not.toHaveBeenCalled();
      expect(isPidAlive(sentinel.pid!)).toBe(true);
    } finally {
      await supervisor.dispose();
      if (tree) {
        await killProcessTree({ pid: tree.provider });
        await killProcessTree({ pid: tree.descendant });
      }
      await killProcessTree(sentinel);
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each(['supervisor', 'codex', 'opencode'] as const)('retires only the %s owned native tree after abrupt controller death', async (entrypoint) => {
    if (process.platform === 'win32') return; // This real SIGKILL vector is POSIX-specific.
    const directory = await mkdtemp(join(tmpdir(), 'happier-native-lifetime-'));
    const readyPath = join(directory, 'ready.json');
    const server = createServer((request, response) => {
      response.writeHead(request.url === '/global/health' ? 200 : 404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ healthy: true, version: '1.0.0' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server did not bind');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const descendant = 'process.send(process.pid); setInterval(() => {}, 1000);';
    const provider = `
      const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.once('message', pid => require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ provider: process.pid, descendant: pid, value: process.env.HAPPIER_NATIVE_FIXTURE_VALUE })));
      setInterval(() => {}, 1000);
    `;
    const invocation = `{ command: ${JSON.stringify(process.execPath)}, args: ['-e', ${JSON.stringify(provider)}] }`;
    const moduleUrl = (path: string) => JSON.stringify(pathToFileURL(resolve(path)).href);
    const controllerSource = entrypoint === 'supervisor' ? `
      const { createAttachedTerminalSupervisor } = await import(${moduleUrl('src/agent/localControl/createAttachedTerminalSupervisor.ts')});
      const supervisor = createAttachedTerminalSupervisor({ resolveInvocation: () => (${invocation}) });
      if (!await supervisor.attach(null)) throw new Error('Native startup was refused');
      setInterval(() => {}, 1000);
    ` : entrypoint === 'codex' ? `
      const { writeCodexSharedControlEndpoint } = await import(${moduleUrl('src/backends/codex/localControl/codexSharedControlEndpoint.ts')});
      await writeCodexSharedControlEndpoint({ happyHomeDir: ${JSON.stringify(directory)}, sessionId: 'fixture', endpoint: 'unix:///fixture.sock' });
      const { runCodexProviderAttach } = await import(${moduleUrl('src/backends/codex/attach/runCodexProviderAttach.ts')});
      await runCodexProviderAttach({ sessionId: 'fixture', happyHomeDir: ${JSON.stringify(directory)}, metadata: { path: ${JSON.stringify(directory)}, codexSessionId: 'fixture-thread', codexBackendMode: 'appServer' }, command: ${JSON.stringify(process.execPath)}, commandArgs: ['-e', ${JSON.stringify(provider)}, '--'] });
    ` : `
      const { runOpenCodeProviderAttach } = await import(${moduleUrl('src/backends/opencode/attach/runOpenCodeProviderAttach.ts')});
      await runOpenCodeProviderAttach({ sessionId: 'fixture', metadata: { path: ${JSON.stringify(directory)}, opencodeSessionId: 'fixture-session', opencodeBackendMode: 'server', opencodeServerBaseUrl: ${JSON.stringify(baseUrl)}, opencodeServerBaseUrlExplicit: true }, command: ${JSON.stringify(process.execPath)}, commandArgs: ['-e', ${JSON.stringify(provider)}, '--'] });
    `;
    const controller = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', controllerSource], {
      env: { PATH: process.env.PATH, HOME: directory, HAPPIER_HOME_DIR: directory, HAPPIER_NATIVE_FIXTURE_VALUE: 'synthetic-native-env' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    let stderr = '';
    controller.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    let tree: { provider: number; descendant: number; value: string } | undefined;
    try {
      await vi.waitFor(async () => {
        try { tree = JSON.parse(await readFile(readyPath, 'utf8')); }
        catch (cause) { throw new Error(`Native fixture not ready (controller=${controller.exitCode}, stderr=${stderr})`, { cause }); }
      }, { timeout: 10_000 });
      expect(tree!.value).toBe('synthetic-native-env');
      expect(isPidAlive(tree!.descendant)).toBe(true);
      controller.kill('SIGKILL');
      await expect(waitForProcessExit(controller.pid!, { timeoutMs: 3_000 })).resolves.toBe(true);
      await expect(waitForProcessExit(tree!.provider, { timeoutMs: 3_000 })).resolves.toBe(true);
      await expect(waitForProcessExit(tree!.descendant, { timeoutMs: 3_000 })).resolves.toBe(true);
      expect(isPidAlive(sentinel.pid!)).toBe(true);
    } finally {
      if (tree) await killProcessTree({ pid: tree.provider });
      await killProcessTree(controller);
      await killProcessTree(sentinel);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
