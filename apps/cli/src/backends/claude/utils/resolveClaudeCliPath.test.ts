import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { createEnvKeyScope } from '@/testkit/env/envScope';

import { isClaudeCliJavaScriptFile, resolveClaudeCliPath } from './resolveClaudeCliPath';

it('preserves the canonical dependency error for an unavailable Claude executable', () => {
  const env = createEnvKeyScope(['HAPPIER_CLAUDE_PATH']);
  process.env.HAPPIER_CLAUDE_PATH = '/missing-private-claude-launcher';
  try {
    let error: unknown;
    try {
      resolveClaudeCliPath();
    } catch (failure) {
      error = failure;
    }
    expect(error).toBeInstanceOf(ReferenceError);
    expect(classifyPrimarySessionRuntimeIssue({ provider: 'claude', cause: 'session_error', error })).toMatchObject({
      source: 'dependency_failure',
      code: 'provider_cli_not_found',
      sanitizedPreview: expect.stringContaining('HAPPIER_CLAUDE_PATH'),
    });
    expect(JSON.stringify(classifyPrimarySessionRuntimeIssue({ error }))).not.toContain('/missing-private');
  } finally {
    env.restore();
  }
});

it.runIf(process.platform !== 'win32')('follows the selected Claude symlink target across provider restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'happier-claude-selected-symlink-'));
  const env = createEnvKeyScope(['HAPPIER_CLAUDE_PATH']);
  const script = join(dir, 'cli.js');
  const native = join(dir, 'native');
  const selected = join(dir, 'claude');
  writeFileSync(script, '', { mode: 0o755 });
  writeFileSync(native, '', { mode: 0o755 });
  symlinkSync(script, selected);
  env.patch({ HAPPIER_CLAUDE_PATH: selected });
  try {
    expect(resolveClaudeCliPath()).toBe(selected);
    // Info/probe launch specs pass the selected command directly to this shared classifier.
    expect(isClaudeCliJavaScriptFile(selected)).toBe(true);
    unlinkSync(selected);
    symlinkSync(native, selected);
    expect(isClaudeCliJavaScriptFile(resolveClaudeCliPath())).toBe(false);
  } finally {
    env.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('leaves a missing executable to the launch boundary instead of failing classification', () => {
  const dir = mkdtempSync(join(tmpdir(), 'happier-claude-missing-launch-'));
  try {
    expect(isClaudeCliJavaScriptFile(join(dir, 'missing.js'))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it.runIf(process.platform !== 'win32')('handles a selected Claude symlink whose target disappeared', () => {
  const dir = mkdtempSync(join(tmpdir(), 'happier-claude-dangling-launch-'));
  const target = join(dir, 'cli.js');
  const selected = join(dir, 'claude');
  writeFileSync(target, '', { mode: 0o755 });
  symlinkSync(target, selected);
  try {
    expect(isClaudeCliJavaScriptFile(selected)).toBe(true);
    unlinkSync(target);
    expect(isClaudeCliJavaScriptFile(selected)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
