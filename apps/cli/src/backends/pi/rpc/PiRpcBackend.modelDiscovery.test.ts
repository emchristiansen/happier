import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probeModelsFromAcpBackend } from '@/capabilities/probes/agentModelsProbe';
import type { AgentMessage } from '@/agent/core';
import { PiRpcBackend } from './PiRpcBackend';

describe('Pi model discovery through the generic probe', () => {
  const directories: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function createBackend(result: 'models' | 'empty' | 'failure' | 'legacy' | 'never' | 'early') {
    const directory = mkdtempSync(join(tmpdir(), 'happier-pi-model-discovery-'));
    directories.push(directory);
    const script = join(directory, 'fake-pi.cjs');
    // Only the provider process is replaced; the RPC backend and generic probe are real.
    writeFileSync(script, `
      const readline = require('node:readline');
      const { pathToFileURL } = require('node:url');
      const { writeFileSync } = require('node:fs');
      let releaseRefresh;
      const released = new Promise(resolve => { releaseRefresh = resolve; });
      let models = [{ provider: 'example', id: 'stale', name: 'Stale' }];
      const registry = {
        getAvailable: () => models,
        getAll: () => models,
        hasConfiguredAuth: () => true,
        getError: () => undefined,
        refresh: async () => {
          if (${JSON.stringify(result)} !== 'early') await released;
          if (${JSON.stringify(result)} === 'never') await new Promise(() => {});
          if (${JSON.stringify(result)} === 'failure') return { aborted: false, errors: new Map([['example', new Error('unavailable')]]) };
          if (${JSON.stringify(result)} === 'legacy') return undefined;
          models = ${result === 'empty' ? '[]' : "[{ provider: 'example', id: 'fresh', name: 'Fresh' }]"};
          return { aborted: false, errors: new Map() };
        },
      };
      (async () => {
        const path = process.argv[process.argv.indexOf('--extension') + 1];
        if (process.argv.includes('--extension')) {
          writeFileSync(${JSON.stringify(join(directory, 'extension-path.txt'))}, path);
          const extension = await import(pathToFileURL(path));
          extension.default({ on: (_event, handler) => { void handler({}, { modelRegistry: registry }); } });
          if (${JSON.stringify(result)} === 'early') setImmediate(() => process.stderr.write('catalog-received\\n'));
        }
        readline.createInterface({ input: process.stdin }).on('line', (line) => {
          const command = JSON.parse(line);
          const reply = (data) => process.stdout.write(JSON.stringify({
            id: command.id, type: 'response', command: command.type, success: true, data,
          }) + '\\n');
          if (command.type === 'get_state') {
            setTimeout(() => reply({ sessionId: 'model-discovery', model: { provider: 'example', id: 'fresh' } }), ${result === 'early' ? 100 : 0});
            if (${JSON.stringify(result)} !== 'never') setTimeout(releaseRefresh, 80);
          } else if (command.type === 'get_available_models') {
            reply({ models: [{ provider: 'example', id: 'stale', name: 'Stale' }] });
          } else reply({ commands: [] });
        });
      })().catch(error => { console.error(error); process.exit(1); });
    `);
    return new PiRpcBackend({ cwd: directory, command: process.execPath, args: [script], env: {} });
  }

  it('waits for model discovery without publishing its initial pending list as empty success', async () => {
    const backend = createBackend('models');
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => { messages.push(message); });
    try {
      const models = await probeModelsFromAcpBackend({ backend, timeoutMs: 5_000 });
      expect(models).toEqual([
        { id: 'default', name: 'Default' },
        { id: 'example/fresh', name: 'Fresh', description: 'example' },
      ]);
      expect(messages.filter((message) => message.type === 'event' && message.name === 'session_models_state'))
        .toEqual([expect.objectContaining({ payload: expect.objectContaining({ availableModels: [expect.objectContaining({ id: 'example/fresh' })] }) })]);
    } finally { await backend.dispose(); }
  });

  it('keeps the receipt timestamp when an early observation waits for runtime state', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const backend = createBackend('early');
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => {
      messages.push(message);
      if (message.type === 'terminal-output' && message.data === 'catalog-received') now.mockReturnValue(2000);
    });
    try {
      await backend.startSession();
      await expect(backend.waitForSessionModels()).resolves.toBe(true);
      expect(Date.now()).toBe(2000);
      expect(messages.find((message) => message.type === 'event' && message.name === 'session_models_state'))
        .toMatchObject({ payload: { observedAt: 1000 } });
    } finally { await backend.dispose(); }
  });


  it.each(['models', 'early'] as const)('preserves the %s observation and its timestamp through current updates', async (result) => {
    const backend = createBackend(result);
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => { messages.push(message); });
    try {
      const { sessionId } = await backend.startSession();
      await expect(backend.waitForSessionModels()).resolves.toBe(true);
      expect(backend.getSessionModelState()?.availableModels.map((model) => model.id)).toEqual(['example/fresh']);
      await backend.setSessionConfigOption(sessionId, 'reasoning_effort', 'high');
      expect(backend.getSessionModelState()?.availableModels.map((model) => model.id)).toEqual(['example/fresh']);
      const catalogEvents = messages.filter((message) => message.type === 'event' && message.name === 'session_models_state');
      expect(catalogEvents).toHaveLength(2);
      const observationTimes = catalogEvents.map((message) => message.type === 'event'
        ? (message.payload as { observedAt: number }).observedAt : undefined);
      expect(observationTimes[0]).toBeGreaterThan(0);
      expect(new Set(observationTimes).size).toBe(1);
    } finally { await backend.dispose(); }
  });

  it('keeps startup nonblocking and settles pending discovery when disposed', async () => {
    const backend = createBackend('never');
    await backend.startSession();
    const extensionPath = readFileSync(join(directories[directories.length - 1]!, 'extension-path.txt'), 'utf8');
    expect(existsSync(extensionPath)).toBe(true);
    const settled = vi.fn();
    const discovery = backend.waitForSessionModels().then(settled);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).not.toHaveBeenCalled();
    await backend.dispose();
    await discovery;
    expect(settled).toHaveBeenCalledWith(false);
    expect(existsSync(extensionPath)).toBe(false);
  });

  it.each(['empty', 'failure', 'legacy'] as const)('distinguishes a completed %s result from a pending snapshot', async (result) => {
    const backend = createBackend(result);
    try {
      const models = await probeModelsFromAcpBackend({ backend, timeoutMs: 5_000 });
      expect(models).toEqual(result === 'empty' ? [{ id: 'default', name: 'Default' }] : null);
    } finally { await backend.dispose(); }
  });
});
