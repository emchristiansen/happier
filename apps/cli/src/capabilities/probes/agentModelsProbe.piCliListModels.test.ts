import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createProbeTempDir } from './agentModelsProbe.testkit';
import { probeAgentModelsBestEffort, resetAgentModelsProbeCacheForTests } from './agentModelsProbe';

describe('probeAgentModelsBestEffort (Pi registry discovery)', () => {
  it('retains its last dynamic observation after unavailable discovery without starting another runtime', async () => {
    const fixture = await createProbeTempDir('happier-pi-registry-models');
    const outcomePath = join(fixture.dir, 'outcome');
    const invocationPath = join(fixture.dir, 'invocations');
    const script = join(fixture.dir, 'pi.cjs');
    // Only Pi's process/registry API is replaced. Its generated extension and all
    // Happier preflight, provenance, normalization and cache handling remain real.
    await writeFile(script, `
const { appendFileSync, readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
appendFileSync(${JSON.stringify(invocationPath)}, process.argv.includes('rpc') ? 'rpc\\n' : 'json\\n');
if (process.argv.includes('rpc')) process.exit(1);
(async () => {
  const handlers = new Map();
  const extension = process.argv[process.argv.indexOf('--extension') + 1];
  const module = await import(pathToFileURL(extension));
  module.default({ on: (event, handler) => handlers.set(event, handler) });
  let models = [{provider:'openai-codex',id:'gpt-5.6-sol',name:'GPT-5.6 Sol'}];
  const registry = {
    getAvailable: () => models, getAll: () => models,
    hasConfiguredAuth: () => true, getError: () => undefined,
    refresh: async () => {
      if (readFileSync(${JSON.stringify(outcomePath)}, 'utf8') === 'legacy') return undefined;
      if (readFileSync(${JSON.stringify(outcomePath)}, 'utf8') === 'failure') return {aborted:false,errors:new Map([['openai-codex',Error('unavailable')]])};
      models = [{provider:'openai-codex',id:'gpt-6-sol',name:'GPT-6 Sol'}];
      return {aborted:false,errors:new Map()};
    },
  };
  await handlers.get('session_start')({}, {modelRegistry:registry});
})().catch(error => {console.error(error);process.exitCode=1});
`);
    const command = writeExecutableShimSync({
      dir: fixture.dir, fileName: process.platform === 'win32' ? 'pi.cmd' : 'pi',
      contents: process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
    });
    resetAgentModelsProbeCacheForTests();
    try {
      const params = {
        agentId: 'pi' as const, cwd: fixture.dir, timeoutMs: 5_000,
        processEnv: { ...process.env, HAPPIER_PI_PATH: command, PI_OFFLINE: undefined },
      };
      await writeFile(outcomePath, 'models');
      const fresh = await probeAgentModelsBestEffort(params);
      expect(fresh).toMatchObject({ source: 'dynamic', availableModels: [
        { id: 'default', name: 'Default' },
        { id: 'openai-codex/gpt-6-sol', name: 'GPT-6 Sol' },
      ] });
      await writeFile(outcomePath, 'legacy');
      const failed = await probeAgentModelsBestEffort({ ...params, bypassCache: true });
      expect(failed).toMatchObject({
        source: 'dynamic', refreshError: true, cacheable: false,
        observedAt: fresh.observedAt, availableModels: fresh.availableModels,
      });
      await writeFile(outcomePath, 'failure');
      expect(await probeAgentModelsBestEffort({ ...params, bypassCache: true })).toMatchObject({
        source: 'dynamic', refreshError: true, cacheable: false,
        observedAt: fresh.observedAt, availableModels: fresh.availableModels,
      });
      expect((await readFile(invocationPath, 'utf8')).trim().split('\n')).toEqual(['json', 'json', 'json']);
    } finally {
      resetAgentModelsProbeCacheForTests();
      await fixture.cleanup();
    }
  });
});
