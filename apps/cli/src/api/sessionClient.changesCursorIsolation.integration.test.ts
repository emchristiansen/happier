import { describe, expect, it, vi } from 'vitest';

const writeAccountChangesCursor = vi.fn(async () => {});
const readAccountChangesCursor = vi.fn(async () => 0);

vi.mock('@/persistence', () => ({
  writeAccountChangesCursor,
  readAccountChangesCursor,
  readCredentials: vi.fn(async () => null),
}));

class FakeSocket {
  connected = false;
  handlers = new Map<string, any>();
  on(event: string, handler: any) {
    this.handlers.set(event, handler);
    return this;
  }
  emit() {}
  connect() {
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
}

vi.mock('./session/sockets', () => ({
  createSessionScopedSocket: () => new FakeSocket(),
  createUserScopedSocket: () => new FakeSocket(),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    infoFile: vi.fn(),
  },
}));

vi.mock('./rpc/handlerManager', () => ({
  RpcHandlerManager: class {
    onSocketConnect() {}
    onSocketDisconnect() {}
    async waitForIdle() {}
    async handleRequest() {
      return '';
    }
  },
}));

vi.mock('./session/handlers', () => ({
  registerSessionHandlers: vi.fn(),
}));

describe('ApiSessionClient changesCursor isolation', () => {
  it('does not persist /v2/changes cursor from socket updates', async () => {
    const { ApiSessionClient } = await import('./session/sessionClient');

    const client = new ApiSessionClient('tok', {
      id: 's1',
      metadata: { path: '/tmp' },
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      encryptionKey: new Uint8Array([1, 2, 3]),
      encryptionVariant: 'v1',
    } as any);

    (client as any).handleUpdate(
      { id: 'upd-1', seq: 999, createdAt: 1, body: { t: 'update-machine', machineId: 'm1' } },
      { source: 'session-scoped' },
    );

    expect(writeAccountChangesCursor).not.toHaveBeenCalled();
    await client.close();
  }, 20_000);

  it('uses the session snapshot pending state even when the account changes cursor is already advanced', async () => {
    readAccountChangesCursor.mockResolvedValueOnce(999);
    const { ApiSessionClient } = await import('./session/sessionClient');

    const client = new ApiSessionClient('tok', {
      id: 's1',
      metadata: { path: '/tmp' },
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      encryptionKey: new Uint8Array([1, 2, 3]),
      encryptionVariant: 'v1',
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 12,
    } as any);

    expect(client.shouldAttemptPendingMaterialization()).toBe(true);
    expect(writeAccountChangesCursor).not.toHaveBeenCalled();
    await client.close();
  }, 20_000);
});
