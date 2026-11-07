import { describe, expect, it, vi } from 'vitest';

import { readCodexLiveAccountIdentity, readCodexLiveAccountIdentityFromClient } from './codexLiveAccountIdentity';

describe('readCodexLiveAccountIdentityFromClient', () => {
  it('reads the native workspace routing identity ahead of legacy account fields', () => {
    // Codex 0.160.0 account/read reports the applied workspace in workspaceRouting.
    expect(readCodexLiveAccountIdentity({
      account: { type: 'chatgpt', email: 'runtime@example.test', id: 'legacy-account' },
      workspaceRouting: { chatgptAccountId: 'workspace-runtime' },
    })).toEqual({ activeAccountId: 'workspace-runtime', accountLabel: 'runtime@example.test' });
  });

  it('forwards lifecycle-owned request options for recovery identity reads', async () => {
    const request = vi.fn(async () => ({
      account: { id: 'acct_runtime', email: 'runtime@example.test' },
    }));

    await expect(readCodexLiveAccountIdentityFromClient(
      { request },
      { timeoutMs: null },
    )).resolves.toEqual({
      activeAccountId: 'acct_runtime',
      accountLabel: 'runtime@example.test',
    });

    expect(request).toHaveBeenCalledWith('account/read', {}, { timeoutMs: null });
  });
});
