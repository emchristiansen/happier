import { describe, expect, it, vi } from 'vitest';

import { promptMultipleChoice, promptMultipleSelection } from './promptMultipleChoice';
import type { promptInput } from './promptInput';

describe('promptMultipleChoice arrow navigation', () => {
  const options = [
    { id: 'first', keys: ['a', 'first', ''], short: 'a' },
    { id: 'second', keys: ['b', 'second'], short: 'b' },
    { id: 'third', keys: ['c', 'third'], short: 'c' },
  ] as const;

  it('wraps arrow selection and maps empty Enter to the highlighted option', async () => {
    const renderMessage = vi.fn((_seconds: number, selectedId?: string) => `selected=${selectedId ?? 'none'}`);
    const promptInputFn = vi.fn(async (_prompt: string, config?: Parameters<typeof promptInput>[1]) => {
      config?.animation?.onMove?.(-1);
      expect(config?.animation?.render(1)).toContain('selected=third');
      return config?.animation?.answerOnEmpty?.() ?? '';
    });

    await expect(promptMultipleChoice('menu', options, {
      defaultId: 'first',
      promptInputFn,
      renderMessage,
    })).resolves.toBe('third');
  });

  it('keeps explicit letter aliases authoritative and resets navigation after an invalid attempt', async () => {
    let attempt = 0;
    const promptInputFn = vi.fn(async (_prompt: string, config?: Parameters<typeof promptInput>[1]) => {
      attempt += 1;
      if (attempt === 1) {
        config?.animation?.onMove?.(1);
        return 'invalid';
      }
      expect(config?.animation?.answerOnEmpty?.()).toBe('a');
      return 'c';
    });

    await expect(promptMultipleChoice('menu', options, {
      defaultId: 'first',
      maxAttempts: 2,
      promptInputFn,
      renderMessage: (_seconds, selectedId) => `selected=${selectedId}`,
    })).resolves.toBe('third');
  });
});

describe('promptMultipleSelection keyboard navigation', () => {
  it('toggles multiple rows and submits them together', async () => {
    const promptInputFn = vi.fn(async (_prompt: string, config?: Parameters<typeof import('./promptInput').promptInput>[1]) => {
      config?.animation?.onToggle?.();
      config?.animation?.onMove?.(1);
      config?.animation?.onToggle?.();
      return config?.animation?.answerOnEmpty?.() ?? '';
    });
    await expect(promptMultipleSelection('Choose agents', [
      { id: 'claude', label: 'Claude Code' },
      { id: 'codex', label: 'Codex' },
      { id: 'skip', label: 'Skip for now', kind: 'skip' },
    ] as const, { promptInputFn })).resolves.toEqual(['claude', 'codex']);
  });

  it('supports numbered/id fallback and explicit skip without animation callbacks', async () => {
    const answers = ['1,codex', 'skip'];
    const promptInputFn = vi.fn(async (_prompt: string) => answers.shift() ?? 'skip');
    const options = [
      { id: 'claude', label: 'Claude Code' },
      { id: 'codex', label: 'Codex' },
      { id: 'skip', label: 'Skip for now', kind: 'skip' as const },
    ];
    await expect(promptMultipleSelection('Choose agents', options, { promptInputFn })).resolves.toEqual(['claude', 'codex']);
    await expect(promptMultipleSelection('Choose agents', options, { promptInputFn })).resolves.toEqual([]);
    expect(promptInputFn.mock.calls[0]?.[0]).toContain('comma-separated numbers or ids');
  });

  it('does not reinterpret exhausted invalid static answers as Skip', async () => {
    const promptInputFn = vi.fn(async (_prompt: string) => 'not-an-agent');

    await expect(promptMultipleSelection('Choose agents', [
      { id: 'claude', label: 'Claude Code' },
      { id: 'skip', label: 'Skip for now', kind: 'skip' },
    ] as const, { promptInputFn })).rejects.toThrow('Invalid selection');
    expect(promptInputFn).toHaveBeenCalledTimes(3);
  });
});
