import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createOpenCodeServerRuntimeClient } from './client';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createOpenCodeServerRuntimeClient providersList', () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.HAPPIER_OPENCODE_SERVER_URL;

  beforeEach(() => {
    process.env.HAPPIER_OPENCODE_SERVER_URL = 'http://example.test';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (typeof originalUrl === 'string') {
      process.env.HAPPIER_OPENCODE_SERVER_URL = originalUrl;
    } else {
      delete process.env.HAPPIER_OPENCODE_SERVER_URL;
    }
  });

  it('returns only connected providers from OpenCode /provider payloads', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : String((input as Request)?.url ?? '');
      if (url.includes('/global/health')) {
        return jsonResponse({ healthy: true, version: '1.2.15' });
      }
      if (url.includes('/provider')) {
        return jsonResponse({
          connected: ['anthropic'],
          all: [
            {
              id: 'anthropic',
              models: {
                'claude-sonnet-4-5': { id: 'claude-sonnet-4-5', status: 'active' },
              },
            },
            {
              id: 'openai',
              models: {
                'gpt-5.2': { id: 'gpt-5.2', status: 'active' },
              },
            },
          ],
        });
      }
      return jsonResponse({});
    }) as typeof fetch;

    const client = await createOpenCodeServerRuntimeClient({
      directory: '',
      messageBuffer: new MessageBuffer(),
    });

    expect(client.supportsInFlightSteer()).toBe(false);
    await expect(client.providersList()).resolves.toEqual([
      expect.objectContaining({ id: 'anthropic' }),
    ]);
  });

  it('keeps OpenCode all-provider payloads when connected providers are not reported', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : String((input as Request)?.url ?? '');
      if (url.includes('/global/health')) {
        return jsonResponse({ healthy: true, version: '1.2.15' });
      }
      if (url.includes('/provider')) {
        return jsonResponse({
          all: [
            { id: 'anthropic', models: {} },
            { id: 'openai', models: {} },
          ],
        });
      }
      return jsonResponse({});
    }) as typeof fetch;

    const client = await createOpenCodeServerRuntimeClient({
      directory: '',
      messageBuffer: new MessageBuffer(),
    });

    await expect(client.providersList()).resolves.toEqual([
      expect.objectContaining({ id: 'anthropic' }),
      expect.objectContaining({ id: 'openai' }),
    ]);
  });

  it.each([{}, { all: [{}] }])('rejects malformed provider inventory (%j) rather than observing an empty inventory', async (payload) => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : String((input as Request)?.url ?? '');
      return jsonResponse(url.includes('/global/health') ? { healthy: true, version: '1.2.15' } : payload);
    }) as typeof fetch;
    const client = await createOpenCodeServerRuntimeClient({ directory: '', messageBuffer: new MessageBuffer() });
    await expect(client.providersList()).rejects.toThrow(/provider inventory/i);
  });
});
