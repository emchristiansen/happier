import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';

vi.mock('./sharedManagedServer', async (importOriginal) => ({
    ...await importOriginal<typeof import('./sharedManagedServer')>(),
    ensureSharedManagedOpenCodeServerBaseUrl: vi.fn(),
    readSharedManagedOpenCodeServerStateBestEffort: vi.fn(async () => null),
    readSharedManagedOpenCodeServerStateByBaseUrlBestEffort: vi.fn(async () => null),
}));

import { createOpenCodeServerRuntimeClient } from './client';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createOpenCodeServerRuntimeClient (session diff)', () => {
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

  it('fetches GET /session/:id/diff with messageID when provided', async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : String((input as any)?.url ?? '');
      urls.push(url);

      if (url.includes('/global/health')) {
        return jsonResponse({ healthy: true, version: '1.2.15' });
      }

      if (url.includes('/session/s1/diff')) {
        return jsonResponse([{ path: 'src/a.ts', diff: 'diff --git a/src/a.ts b/src/a.ts' }]);
      }

      return jsonResponse({});
    }) as any;

    const client = await createOpenCodeServerRuntimeClient({
      directory: '',
      messageBuffer: new MessageBuffer(),
    });

    const diff = await client.sessionDiff({ sessionId: 's1', messageId: 'msg_1' });
    expect(diff).toEqual([{ path: 'src/a.ts', diff: 'diff --git a/src/a.ts b/src/a.ts' }]);
    expect(urls.some((url) => url.includes('/session/s1/diff') && url.includes('messageID=msg_1'))).toBe(true);
  });

  it('retries session diff after a transient managed-server fetch failure', async () => {
    delete process.env.HAPPIER_OPENCODE_SERVER_URL;

    const { ensureSharedManagedOpenCodeServerBaseUrl, readSharedManagedOpenCodeServerStateBestEffort } = await import('./sharedManagedServer');
    const ensureMock = ensureSharedManagedOpenCodeServerBaseUrl as unknown as ReturnType<typeof vi.fn>;
    const readMock = readSharedManagedOpenCodeServerStateBestEffort as unknown as ReturnType<typeof vi.fn>;

    ensureMock.mockResolvedValueOnce('http://127.0.0.1:9999');
    // The client reads the shared managed-server state both at construction (identity baseline) and
    // again on the transport-failure retry path, so the mock must be persistent — a single
    // `mockResolvedValueOnce` would leave the retry read undefined.
    readMock.mockResolvedValue({
      baseUrl: 'http://127.0.0.1:10000',
      pid: process.pid,
      startedAtMs: Date.now(),
    });

    const urls: string[] = [];
    let diffAttempts = 0;
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : String((input as any)?.url ?? '');
      urls.push(url);

      if (url.includes('127.0.0.1:9999/global/health')) {
        return jsonResponse({ healthy: true, version: '1.2.15' });
      }

      if (url.includes('127.0.0.1:10000/global/health')) {
        return jsonResponse({ healthy: true, version: '1.2.15' });
      }

      if (url.includes('/session/s1/diff')) {
        diffAttempts += 1;
        if (diffAttempts === 1) {
          throw new TypeError('fetch failed');
        }
        return jsonResponse([{ path: 'src/a.ts', diff: 'diff --git a/src/a.ts b/src/a.ts' }]);
      }

      return jsonResponse({});
    }) as any;

    const client = await createOpenCodeServerRuntimeClient({
      directory: '',
      messageBuffer: new MessageBuffer(),
    });

    await expect(client.sessionDiff({ sessionId: 's1', messageId: 'msg_1' })).resolves.toEqual([
      { path: 'src/a.ts', diff: 'diff --git a/src/a.ts b/src/a.ts' },
    ]);

    const diffUrls = urls.filter((url) => url.includes('/session/s1/diff'));
    expect(diffUrls).toEqual([
      expect.stringContaining('127.0.0.1:9999/session/s1/diff'),
      expect.stringContaining('127.0.0.1:10000/session/s1/diff'),
    ]);
  });
});
