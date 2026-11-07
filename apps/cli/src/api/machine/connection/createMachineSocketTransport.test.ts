import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectedServiceIdSchema } from '@happier-dev/protocol';

const ioMock = vi.hoisted(() => vi.fn((_url: string, _options: { auth?: Record<string, unknown> }) => ({
  on: vi.fn(),
})));

vi.mock('socket.io-client', () => ({
  io: ioMock,
}));

vi.mock('@/utils/proxy/socketIoProxy', () => ({
  getSocketIoProxyOptions: () => ({}),
}));

describe('createMachineSocketTransport', () => {
  beforeEach(() => {
    ioMock.mockClear();
  });

  it('includes installation identity fields in machine-scoped socket auth when provided', async () => {
    const { createMachineSocketTransport } = await import('./createMachineSocketTransport');

    createMachineSocketTransport({
      serverUrl: 'https://api.example.com',
      token: 'token',
      machineId: 'machine-1',
      installationId: 'installation-1',
      installationPublicKey: 'public-key',
      installationProof: {
        version: 1,
        algorithm: 'ed25519',
        signature: 'signature',
      },
      env: {},
    });

    expect(ioMock).toHaveBeenCalledWith('https://api.example.com', expect.objectContaining({
      auth: expect.objectContaining({
        connectedServiceIds: ConnectedServiceIdSchema.options,
        clientType: 'machine-scoped',
        machineId: 'machine-1',
        installationId: 'installation-1',
        installationPublicKey: 'public-key',
        installationProof: {
          version: 1,
          algorithm: 'ed25519',
          signature: 'signature',
        },
      }),
    }));
    expect(ioMock.mock.calls[0]?.[1]?.auth).not.toHaveProperty('clientCompatibility');
  });
});
