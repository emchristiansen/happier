import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readCodexSharedControlEndpoint: vi.fn(async ({ sessionId }: { sessionId: string }) => (
    sessionId === 'happy-local-descriptor'
      ? {
          version: 1 as const,
          sessionId,
          endpoint: 'unix:///tmp/happier-codex/private/app-server.sock',
          updatedAt: 1,
        }
      : null
  )),
}));

vi.mock('../localControl/codexSharedControlEndpoint', () => ({
  readCodexSharedControlEndpoint: mocks.readCodexSharedControlEndpoint,
}));

import { codexProviderAttachOps } from './providerAttachOps';

describe('codexProviderAttachOps', () => {
  it('allows same-machine App Server sessions with a published Codex thread', async () => {
    expect(await codexProviderAttachOps.evaluateEligibility({
      sessionId: 'happy-same-machine',
      metadata: {
        path: '/tmp/repo',
        codexSessionId: 'thread-1',
        codexBackendMode: 'appServer',
      },
      currentMachineId: 'machine-1',
      sessionMachineId: 'machine-1',
      hasLocalAttachmentInfo: false,
    })).toMatchObject({ eligible: true, scope: 'local' });
  });

  it('rejects cross-machine sockets and non-App-Server Codex sessions', async () => {
    expect(await codexProviderAttachOps.evaluateEligibility({
      sessionId: 'happy-cross-machine',
      metadata: { path: '/tmp/repo', codexSessionId: 'thread-1', codexBackendMode: 'appServer' },
      currentMachineId: 'machine-2',
      sessionMachineId: 'machine-1',
      hasLocalAttachmentInfo: false,
    })).toMatchObject({ eligible: false });
    expect(await codexProviderAttachOps.evaluateEligibility({
      sessionId: 'happy-acp',
      metadata: { path: '/tmp/repo', codexSessionId: 'thread-1', codexBackendMode: 'acp' },
      currentMachineId: 'machine-1',
      sessionMachineId: 'machine-1',
      hasLocalAttachmentInfo: false,
    })).toMatchObject({ eligible: false });
  });

  it('accepts a runner-owned local endpoint descriptor when persisted machine identity has rotated', async () => {
    expect(await codexProviderAttachOps.evaluateEligibility({
      sessionId: 'happy-local-descriptor',
      metadata: { path: '/tmp/repo', codexSessionId: 'thread-1', codexBackendMode: 'appServer' },
      currentMachineId: 'machine-after-reauth',
      sessionMachineId: 'machine-before-reauth',
      hasLocalAttachmentInfo: false,
    })).toMatchObject({ eligible: true, scope: 'local' });
  });
});
