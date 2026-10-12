import { afterEach, describe, expect, it } from 'vitest';

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';

import { openCodePreflightModelsProbeAdapter } from './openCodePreflightModelsProbeAdapter';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const envKeys = ['HAPPIER_OPENCODE_PATH', 'PATH'] as const;
let envScope = createEnvKeyScope(envKeys);

afterEach(() => {
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
});

function writeFakeOpenCodeModelsBinary(dir: string, stdoutLines: ReadonlyArray<string>): string {
  const isWindows = process.platform === 'win32';
  const fileName = isWindows ? 'opencode.cmd' : 'opencode';
  const output = stdoutLines.join(isWindows ? '\r\n' : '\n');
  const contents = isWindows
    ? [
        '@echo off',
        // Best-effort; this suite runs on non-Windows in CI/dev. Keep the shim simple.
        ...output.split(/\r?\n/).map((l) => `echo ${l}`),
        `echo invoked> "${join(dir, 'invoked.txt')}"`,
        'exit /b 0',
      ].join('\r\n')
    : [
        '#!/bin/sh',
        `printf '%s' invoked > "${join(dir, 'invoked.txt')}"`,
        "cat <<'EOF'",
        output,
        'EOF',
        'exit 0',
      ].join('\n');
  return writeExecutableShimSync({ dir, fileName, contents });
}

function writeFakeOpenCodeModelsJavaScriptEntrypoint(dir: string, stdoutLines: ReadonlyArray<string>): string {
  const output = JSON.stringify(stdoutLines.join('\n'));
  const contents = [
    `const { writeFileSync } = require('node:fs');`,
    `const { join } = require('node:path');`,
    `writeFileSync(join(${JSON.stringify(dir)}, 'invoked-js.txt'), process.argv.slice(2).join(' '));`,
    `process.stdout.write(${output});`,
  ].join('\n');
  return writeExecutableShimSync({ dir, fileName: 'opencode.js', contents });
}

function writeFakeOpenCodeV2ModelsJavaScriptEntrypoint(dir: string, response: unknown): string {
  const contents = [
    `const { writeFileSync } = require('node:fs');`,
    `const { join } = require('node:path');`,
    `const args = process.argv.slice(2);`,
    `writeFileSync(join(${JSON.stringify(dir)}, 'invoked-v2.txt'), args.join(' '));`,
    `if (args[0] !== 'api' || args[1] !== 'get' || args[2] !== '/api/model' || !args.includes('--standalone')) process.exit(2);`,
    `process.stdout.write(${JSON.stringify(JSON.stringify(response))});`,
  ].join('\n');
  return writeExecutableShimSync({ dir, fileName: 'opencode.js', contents });
}

describe('openCodePreflightModelsProbeAdapter', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it.each([
    { models: [] },
    { models: [{ id: 'image-only', providerID: 'example', capabilities: { input: ['image'] } }] },
  ])('preserves an authoritative catalog with no selectable models ($models)', async ({ models }) => {
    tempDir = makeTempDir('happier-opencode-preflight-empty-');
    const fakeOpenCode = writeFakeOpenCodeV2ModelsJavaScriptEntrypoint(tempDir, { data: models });
    const raw = await openCodePreflightModelsProbeAdapter.probeModelsRaw?.({
      cwd: tempDir,
      timeoutMs: 2_000,
      processEnv: { ...process.env, HAPPIER_OPENCODE_PATH: fakeOpenCode },
    });
    expect(raw).toEqual([]);
  });

  it('reads rich model metadata from the released OpenCode V2 model API command', async () => {
    tempDir = makeTempDir('happier-opencode-preflight-models-v2-');
    const fakeOpenCode = writeFakeOpenCodeV2ModelsJavaScriptEntrypoint(tempDir, {
      location: { directory: tempDir },
      data: [
        {
          id: 'gpt-5.4',
          modelID: 'gpt-5.4',
          providerID: 'openai',
          name: 'GPT-5.4',
          family: 'gpt-5.4',
          status: 'active',
          enabled: true,
          capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
          variants: [{ id: 'low' }, { id: 'high' }],
          limit: { context: 400000, output: 128000 },
        },
        {
          id: 'no-tools',
          modelID: 'no-tools',
          providerID: 'openai',
          name: 'No Tools',
          status: 'active',
          enabled: true,
          capabilities: { tools: false, input: ['text'], output: ['text'] },
          variants: [],
          limit: { context: 100000, output: 10000 },
        },
      ],
    });

    process.env.PATH = '/usr/bin:/bin';
    process.env.HAPPIER_OPENCODE_PATH = fakeOpenCode;

    const raw = await openCodePreflightModelsProbeAdapter.probeModelsRaw?.({
      cwd: tempDir,
      timeoutMs: 2_000,
      backendTarget: undefined,
      accountSettings: null,
    });

    expect(readFileSync(join(tempDir, 'invoked-v2.txt'), 'utf8'))
      .toBe(`api get /api/model --standalone --param location[directory]=${tempDir}`);
    expect(raw).toEqual([{
      id: 'openai/gpt-5.4',
      name: 'GPT-5.4',
      description: 'gpt-5.4',
      contextWindowTokens: 400000,
      modelOptions: [{
        id: 'reasoning_effort',
        name: 'Thinking',
        type: 'select',
        currentValue: 'high',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
        ],
      }],
    }, {
      id: 'openai/no-tools',
      name: 'No Tools',
      description: 'openai',
      contextWindowTokens: 100000,
    }]);
  });

  it('includes a model-scoped Thinking option derived from OpenCode model variants when reasoning is supported', async () => {
    tempDir = makeTempDir('happier-opencode-preflight-models-');
    const fakeOpenCode = writeFakeOpenCodeModelsBinary(tempDir, [
      'openai/codex-mini-latest',
      '{',
      '  "id": "codex-mini-latest",',
      '  "providerID": "openai",',
      '  "name": "Codex Mini",',
      '  "family": "gpt-codex-mini",',
      '  "status": "active",',
      '  "capabilities": { "toolcall": true, "reasoning": true, "input": { "text": true, "contextWindow": 400000 } },',
      '  "variants": {',
      '    "low": { "reasoningEffort": "low" },',
      '    "medium": { "reasoningEffort": "medium" },',
      '    "high": { "reasoningEffort": "high" }',
      '  }',
      '}',
      'openai/gpt-4o-mini',
      '{',
      '  "id": "gpt-4o-mini",',
      '  "providerID": "openai",',
      '  "name": "GPT-4o Mini",',
      '  "family": "gpt-4o",',
      '  "status": "active",',
      '  "capabilities": { "toolcall": true, "reasoning": false, "input": { "text": true } },',
      '  "variants": { "high": { "reasoningEffort": "high" } }',
      '}',
    ]);

    process.env.PATH = '/usr/bin:/bin';
    process.env.HAPPIER_OPENCODE_PATH = fakeOpenCode;

    const stdout = execFileSync(fakeOpenCode, ['models', '--verbose'], { cwd: tempDir, encoding: 'utf8' });
    expect(stdout).toContain('openai/codex-mini-latest');
    expect(stdout).toContain('"variants"');

    const raw = await openCodePreflightModelsProbeAdapter.probeModelsRaw?.({
      cwd: tempDir,
      timeoutMs: 2_000,
      backendTarget: undefined,
      accountSettings: null,
    });
    expect(existsSync(join(tempDir, 'invoked.txt'))).toBe(true);

    expect(raw).toEqual([
      {
        id: 'openai/codex-mini-latest',
        name: 'Codex Mini',
        description: 'gpt-codex-mini',
        contextWindowTokens: 400000,
        modelOptions: [
          {
            id: 'reasoning_effort',
            name: 'Thinking',
            type: 'select',
            currentValue: 'medium',
            options: [
              { value: 'low', name: 'Low' },
              { value: 'medium', name: 'Medium' },
              { value: 'high', name: 'High' },
            ],
          },
        ],
      },
      {
        id: 'openai/gpt-4o-mini',
        name: 'GPT-4o Mini',
        description: 'gpt-4o',
      },
    ]);
  });

  it('includes nested OpenRouter model ids from verbose output', async () => {
    tempDir = makeTempDir('happier-opencode-preflight-models-nested-');
    const fakeOpenCode = writeFakeOpenCodeModelsBinary(tempDir, [
      'opencode/gpt-5',
      '{"id":"gpt-5","providerID":"opencode","name":"GPT-5","status":"active","capabilities":{"toolcall":true}}',
      'openrouter/deepseek/deepseek-v4-flash-0731',
      '{"id":"deepseek/deepseek-v4-flash-0731","providerID":"openrouter","name":"DeepSeek V4 Flash","status":"active","capabilities":{"toolcall":true}}',
      'openrouter/~anthropic/claude-opus-latest',
      '{"id":"~anthropic/claude-opus-latest","providerID":"openrouter","name":"Claude Opus Latest","status":"active","capabilities":{"toolcall":true}}',
    ]);

    process.env.PATH = '/usr/bin:/bin';
    process.env.HAPPIER_OPENCODE_PATH = fakeOpenCode;

    const raw = await openCodePreflightModelsProbeAdapter.probeModelsRaw?.({
      cwd: tempDir,
      timeoutMs: 2_000,
      backendTarget: undefined,
      accountSettings: null,
    });

    expect(raw).toEqual([
      { id: 'opencode/gpt-5', name: 'GPT-5', description: 'opencode' },
      {
        id: 'openrouter/deepseek/deepseek-v4-flash-0731',
        name: 'DeepSeek V4 Flash',
        description: 'openrouter',
      },
      {
        id: 'openrouter/~anthropic/claude-opus-latest',
        name: 'Claude Opus Latest',
        description: 'openrouter',
      },
    ]);
  });

  it('rejects a partial verbose inventory when a header disagrees with its record identity', async () => {
    tempDir = makeTempDir('happier-opencode-preflight-models-identity-');
    const fakeOpenCode = writeFakeOpenCodeModelsBinary(tempDir, [
      'opencode/gpt-5',
      '{"id":"gpt-5","providerID":"opencode","name":"GPT-5","status":"active","capabilities":{"toolcall":true}}',
      'openrouter/incorrect/model-id',
      '{"id":"deepseek/deepseek-v4-flash-0731","providerID":"openrouter","name":"DeepSeek V4 Flash","status":"active","capabilities":{"toolcall":true}}',
    ]);

    process.env.PATH = '/usr/bin:/bin';
    process.env.HAPPIER_OPENCODE_PATH = fakeOpenCode;

    await expect(openCodePreflightModelsProbeAdapter.probeModelsRaw?.({
      cwd: tempDir,
      timeoutMs: 2_000,
      backendTarget: undefined,
      accountSettings: null,
    })).resolves.toBeNull();
  });

  it('reads contextWindowTokens from OpenCode limit.context provider metadata', async () => {
    tempDir = makeTempDir('happier-opencode-preflight-models-limit-context-');
    const fakeOpenCode = writeFakeOpenCodeModelsBinary(tempDir, [
      'openai/gpt-5.3-codex',
      '{',
      '  "id": "gpt-5.3-codex",',
      '  "providerID": "openai",',
      '  "name": "GPT-5.3 Codex",',
      '  "family": "gpt-5.3",',
      '  "status": "active",',
      '  "capabilities": { "toolcall": true, "input": { "text": true } },',
      '  "limit": { "context": 400000, "input": 272000, "output": 128000 }',
      '}',
    ]);

    process.env.PATH = '/usr/bin:/bin';
    process.env.HAPPIER_OPENCODE_PATH = fakeOpenCode;

    const raw = await openCodePreflightModelsProbeAdapter.probeModelsRaw?.({
      cwd: tempDir,
      timeoutMs: 2_000,
      backendTarget: undefined,
      accountSettings: null,
    });

    expect(raw).toEqual([
      {
        id: 'openai/gpt-5.3-codex',
        name: 'GPT-5.3 Codex',
        description: 'gpt-5.3',
        contextWindowTokens: 400000,
      },
    ]);
  });

  it('excludes Anthropic models that OpenCode still advertises after provider retirement', async () => {
    tempDir = makeTempDir('happier-opencode-preflight-models-retired-');
    const fakeOpenCode = writeFakeOpenCodeModelsBinary(tempDir, [
      'anthropic/claude-3-5-haiku-20241022',
      '{',
      '  "id": "claude-3-5-haiku-20241022",',
      '  "providerID": "anthropic",',
      '  "name": "Claude Haiku 3.5",',
      '  "family": "claude-haiku",',
      '  "status": "active",',
      '  "capabilities": { "toolcall": true, "input": { "text": true } }',
      '}',
      'anthropic/claude-haiku-4-5-20251001',
      '{',
      '  "id": "claude-haiku-4-5-20251001",',
      '  "providerID": "anthropic",',
      '  "name": "Claude Haiku 4.5",',
      '  "family": "claude-haiku",',
      '  "status": "active",',
      '  "capabilities": { "toolcall": true, "input": { "text": true } }',
      '}',
    ]);

    process.env.PATH = '/usr/bin:/bin';
    process.env.HAPPIER_OPENCODE_PATH = fakeOpenCode;

    const raw = await openCodePreflightModelsProbeAdapter.probeModelsRaw?.({
      cwd: tempDir,
      timeoutMs: 2_000,
      backendTarget: undefined,
      accountSettings: null,
    });

    expect(raw).toEqual([
      {
        id: 'anthropic/claude-haiku-4-5-20251001',
        name: 'Claude Haiku 4.5',
        description: 'claude-haiku',
      },
    ]);
  });

  it('wraps JavaScript OpenCode CLI entrypoints with the managed JavaScript runtime during probes', async () => {
    tempDir = makeTempDir('happier-opencode-preflight-models-js-');
    const fakeOpenCode = writeFakeOpenCodeModelsJavaScriptEntrypoint(tempDir, [
      'openai/gpt-5.3-codex',
      '{',
      '  "id": "gpt-5.3-codex",',
      '  "providerID": "openai",',
      '  "name": "GPT-5.3 Codex",',
      '  "capabilities": { "toolcall": true, "input": { "text": true } }',
      '}',
    ]);

    process.env.PATH = '/usr/bin:/bin';
    process.env.HAPPIER_OPENCODE_PATH = fakeOpenCode;

    const raw = await openCodePreflightModelsProbeAdapter.probeModelsRaw?.({
      cwd: tempDir,
      timeoutMs: 2_000,
      backendTarget: undefined,
      accountSettings: null,
    });

    expect(existsSync(join(tempDir, 'invoked-js.txt'))).toBe(true);
    expect(raw).toEqual([{
      id: 'openai/gpt-5.3-codex',
      name: 'GPT-5.3 Codex',
      description: 'openai',
    }]);
  });
});
