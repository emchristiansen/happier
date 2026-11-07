import { describe, expect, it, vi } from 'vitest';

const createZellijTerminalHostAdapter = vi.hoisted(() => vi.fn(() => ({ kind: 'zellij' })));
const createHerdrTerminalHostAdapter = vi.hoisted(() => vi.fn(() => ({ kind: 'herdr' })));

vi.mock('@/configuration', () => ({
  configuration: {
    happyHomeDir: '/home/happier',
    claudeUnifiedTerminalHostActionTimeoutMs: 15_000,
  },
}));
vi.mock('@/integrations/tmux', () => ({
  createTmuxTerminalHostAdapter: () => ({ kind: 'tmux' }),
}));
vi.mock('@/integrations/zellij/adapter', () => ({
  DEFAULT_ZELLIJ_STARTUP_ACTION_TIMEOUT_MS: 60_000,
  createZellijTerminalHostAdapter,
}));
vi.mock('@/integrations/zellij/runtimeBinary', () => ({
  resolveZellijRuntimeBinary: async () => '/tools/zellij',
}));
vi.mock('@/integrations/herdr/runtimeBinary', () => ({
  resolveHerdrRuntimeBinary: async () => '/tools/herdr',
}));
vi.mock('@/integrations/herdr/adapter', () => ({
  createHerdrTerminalHostAdapter,
}));
vi.mock('./registry', () => ({
  createTerminalHostRegistry: (adapters: unknown) => adapters,
}));

import { createDefaultTerminalHostRegistry } from './defaultRegistry';

describe('createDefaultTerminalHostRegistry', () => {
  it('does not let the routine action timeout undercut Zellij startup', async () => {
    await createDefaultTerminalHostRegistry();

    expect(createZellijTerminalHostAdapter).toHaveBeenCalledWith(expect.objectContaining({
      actionTimeoutMs: 15_000,
      startupActionTimeoutMs: 60_000,
    }));
  });

  it('registers a supported Herdr alongside existing terminal hosts', async () => {
    await expect(createDefaultTerminalHostRegistry()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tmux' }),
      expect.objectContaining({ kind: 'zellij' }),
      expect.objectContaining({ kind: 'herdr' }),
    ]));
  });

  it('passes one provider prompt-verification policy to every configured host', async () => {
    const policy = {
      shouldVerifyAfterSubmit: () => true,
      isPromptStagedBeforeSubmit: () => true,
      isPromptStillPendingAfterSubmit: () => false,
    };
    await createDefaultTerminalHostRegistry({ promptSubmitVerification: policy });
    expect(createZellijTerminalHostAdapter).toHaveBeenCalledWith(expect.objectContaining({
      promptSubmitVerification: policy,
    }));
    expect(createHerdrTerminalHostAdapter).toHaveBeenCalledWith(expect.objectContaining({
      promptSubmitVerification: policy,
    }));
  });
});
