import { describe, expect, it, vi } from 'vitest';
import { createOfflineAxios } from './offlineAxios';

describe('network-free Axios boundary', () => {
  it.each([
    'http://127.0.0.1:3005/v2/sessions',
    'http://localhost:3005/v2/account/settings',
    'https://api.happier.dev/v2/sessions',
    'https://example.com/v2/account/settings',
    'https://relay.example.invalid.evil.example/v2/sessions',
  ])('refuses %s before invoking any fixture', (url) => {
    const read = vi.fn();
    expect(() => createOfflineAxios(read).get(url)).toThrow('Offline HTTP boundary refused origin');
    expect(read).not.toHaveBeenCalled();
  });

  it('dispatches only the exact offline origin and retains unknown-route errors', async () => {
    const read = vi.fn(async (url: string) => {
      if (url !== 'https://relay.example.invalid/v2/sessions') throw new Error('Unknown offline route');
      return { status: 200, data: { sessions: [] } };
    });
    const client = createOfflineAxios(read);
    await expect(client.get('https://relay.example.invalid/v2/sessions')).resolves.toMatchObject({ status: 200 });
    await expect(client.get('https://relay.example.invalid/unknown')).rejects.toThrow('Unknown offline route');
  });

  it.each(['request', 'create', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const)(
    'refuses unconfigured %s without a real HTTP implementation', (method) => {
      const read = vi.fn();
      expect(() => createOfflineAxios(read)[method]()).toThrow('Unconfigured offline HTTP operation');
      expect(read).not.toHaveBeenCalled();
    },
  );
});
