import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ model: 'old', fail: false, probes: 0 }));
// The process boundary stands in for an installed Kilo CLI; all catalog/probe/cache logic is real.
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: (_command: unknown, args: unknown) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true });
    queueMicrotask(() => {
      if (Array.isArray(args) && args.includes('models')) {
        boundary.probes += 1;
        if (!boundary.fail) child.stdout.emit('data', Buffer.from(`${boundary.model}\n`));
        child.emit('close', boundary.fail ? 1 : 0);
      } else child.emit('error', new Error('CLI unavailable'));
    });
    return child as unknown as ChildProcess;
  },
}));

import { probeAgentModelsBestEffort, resetAgentModelsProbeCacheForTests } from './agentModelsProbe';

beforeEach(() => { resetAgentModelsProbeCacheForTests(); boundary.model = 'old'; boundary.fail = false; boundary.probes = 0; });
afterEach(resetAgentModelsProbeCacheForTests);

it('refreshes warm generic results once and preserves the last successful observation on failure', async () => {
  const params = { agentId: 'kilo' as const, cwd: process.cwd(), timeoutMs: 250 };
  const initial = await probeAgentModelsBestEffort(params);
  expect(initial.availableModels.map(model => model.id)).toEqual(['default', 'old']);
  boundary.model = 'new';
  expect(await probeAgentModelsBestEffort(params)).toEqual(initial);
  const [fresh, concurrent] = await Promise.all([
    probeAgentModelsBestEffort({ ...params, bypassCache: true }),
    probeAgentModelsBestEffort({ ...params, bypassCache: true }),
  ]);
  expect(fresh.availableModels.map(model => model.id)).toEqual(['default', 'new']);
  expect(concurrent).toEqual(fresh);
  expect(boundary.probes).toBe(2);
  boundary.fail = true;
  const failed = await probeAgentModelsBestEffort({ ...params, bypassCache: true });
  expect(failed).toMatchObject({ refreshError: true, cacheable: false, observedAt: fresh.observedAt, availableModels: fresh.availableModels });
  expect(await probeAgentModelsBestEffort(params)).toEqual(failed);
});

it('reports policy-disabled Claude discovery as intentional static success', async () => {
  const result = await probeAgentModelsBestEffort({
    agentId: 'claude', cwd: process.cwd(), timeoutMs: 250,
    accountSettings: { claudeDynamicModelProbeEnabled: false }, bypassCache: true,
  });
  expect(result).toMatchObject({ source: 'static', refreshError: false });
  expect(result.availableModels.length).toBeGreaterThan(1);
});
