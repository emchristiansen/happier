import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeExecutableShimSync } from '@/testkit/fs/executableShim';

import { piPreflightModelsProbeAdapter } from './piPreflightModelsProbeAdapter';

// Pi is the external process/extension API boundary. The actual Happier extension,
// launch resolution, parser and model projection all run in these tests.
function writeFakePi(dir: string, outcome: 'models' | 'plain' | 'empty' | 'failure' | 'legacy' | 'hang') {
  const path = join(dir, 'pi.cjs');
  writeFileSync(path, `
    const { pathToFileURL } = require('node:url');
    const args = process.argv.slice(2);
    if (args.includes('--list-models')) {
      console.log('provider model context max-out thinking images\\nopenai-codex gpt-5.6-sol 200K 4K yes yes');
    } else {
      (async () => {
        if (!args.includes('--no-session')) throw Error('probe must not persist a session');
        const extension = args[args.indexOf('--extension') + 1];
        const handlers = new Map();
        const module = await import(pathToFileURL(extension));
        module.default({ on: (event, handler) => handlers.set(event, handler) });
        let models = [{provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', reasoning: true}];
        const registry = {
          getAvailable: () => models,
          getAll: () => models,
          hasConfiguredAuth: () => true,
          getError: () => undefined,
          refresh: async (options) => {
            if (${JSON.stringify(outcome)} === 'hang') return new Promise(() => setInterval(() => {}, 1000));
            await new Promise(resolve => setTimeout(resolve, 35));
            if (${JSON.stringify(outcome)} === 'legacy') return undefined;
            if (${JSON.stringify(outcome)} === 'failure') return {aborted:false, errors:new Map([['openai-codex',Error('network unavailable')]])};
            if (!options.allowNetwork) throw Error('network refresh missing');
            if (JSON.stringify(options.providers) !== JSON.stringify(['openai-codex'])) throw Error('unrelated providers refreshed');
            models = ${JSON.stringify(outcome)} === 'empty' ? [] : [{
              provider: process.env.PI_TEST_SELECTED_PROVIDER,
              id: options.force ? 'gpt-6-sol' : 'gpt-5.6-sol',
              name: options.force ? 'GPT-6 Sol' : 'GPT-5.6 Sol', reasoning: ${JSON.stringify(outcome)} !== 'plain',
            }];
            return {aborted:false, errors:new Map()};
          },
        };
        await handlers.get('session_start')({}, {modelRegistry:registry});
      })().catch(error => {console.error(error.message);process.exitCode=1});
    }
  `);
  return writeExecutableShimSync({
    dir, fileName: process.platform === 'win32' ? 'pi.cmd' : 'pi',
    contents: process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${path}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${path}" "$@"\n`,
  });
}

describe('piPreflightModelsProbeAdapter', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  async function probe(outcome: Parameters<typeof writeFakePi>[1], bypassCache = true, timeoutMs = 5_000, offline?: string) {
    const directory = mkdtempSync(join(tmpdir(), 'happier-pi-preflight-models-'));
    directories.push(directory);
    const command = writeFakePi(directory, outcome);
    return await piPreflightModelsProbeAdapter.probeModelsRaw?.({
      cwd: directory, timeoutMs, backendTarget: undefined, accountSettings: null, bypassCache,
      processEnv: {...process.env, HAPPIER_PI_PATH: command, PI_TEST_SELECTED_PROVIDER: 'openai-codex', PI_OFFLINE: offline},
    });
  }

  it('awaits Pi refresh and preserves structured names and thinking controls under selected auth', async () => {
    const result = await probe('models');
    expect(result).toEqual([expect.objectContaining({
      id: 'openai-codex/gpt-6-sol', name: 'GPT-6 Sol', description: 'openai-codex',
      modelOptions: [expect.objectContaining({id:'reasoning_effort'})],
    })]);
  });

  it('lets Pi reuse its own fresh catalog unless refresh is explicitly forced', async () => {
    expect(await probe('models', false)).toEqual([expect.objectContaining({
      id: 'openai-codex/gpt-5.6-sol', name: 'GPT-5.6 Sol',
    })]);
  });

  it('does not invent thinking controls for models without reasoning support', async () => {
    expect(await probe('plain')).toEqual([{
      id: 'openai-codex/gpt-6-sol', name: 'GPT-6 Sol', description: 'openai-codex',
    }]);
  });

  it('preserves a completed empty catalog', async () => {
    expect(await probe('empty')).toEqual([]);
  });

  it('retains named local choices as an explicitly stale fallback when Pi cannot prove refresh', async () => {
    expect(await probe('legacy')).toEqual({
      source: 'static', refreshError: true,
      availableModels: [expect.objectContaining({ id: 'openai-codex/gpt-5.6-sol', name: 'GPT-5.6 Sol' })],
    });
  });

  it('does not promote a stale snapshot when refresh fails', async () => {
    expect(await probe('failure')).toBeNull();
  });

  it.each(['0', 'false'])('refreshes when PI_OFFLINE is %s', async (offline) => {
    expect(await probe('models', true, 5_000, offline)).toEqual([expect.objectContaining({
      id: 'openai-codex/gpt-6-sol', name: 'GPT-6 Sol',
    })]);
  });

  it.each(['1', 'true', 'YES'])('does not claim fresh models when PI_OFFLINE is %s', async (offline) => {
    expect(await probe('models', true, 5_000, offline)).toBeNull();
  });

  it('uses the caller deadline to stop an unsettled Pi refresh', async () => {
    expect(await probe('hang', true, 300)).toBeNull();
  });
});
