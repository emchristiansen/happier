import { describe, expect, it, vi } from 'vitest';

import { resolveOpenCodeAttachCliDialect } from './resolveOpenCodeAttachCliDialect';

const BASE_URL = 'http://127.0.0.1:4096';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('resolveOpenCodeAttachCliDialect', () => {
  it('detects the released OpenCode 2 dialect from the server info surface', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({
      version: '2.0.15',
      pid: 4242,
      urls: [BASE_URL],
      paths: { data: '/tmp' },
    }));

    await expect(resolveOpenCodeAttachCliDialect({
      baseUrl: BASE_URL,
      headers: { Authorization: 'Basic x' },
      fetchFn: fetchFn as unknown as typeof fetch,
    })).resolves.toBe('v2');

    expect(fetchFn).toHaveBeenCalledWith(
      `${BASE_URL}/api/info`,
      expect.objectContaining({ headers: { Authorization: 'Basic x' } }),
    );
  });

  it('keeps the retained v1 dialect when the target does not expose the v2 info surface', async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      return path === '/global/health'
        ? jsonResponse({ healthy: true, version: '0.14.2' })
        : jsonResponse({ message: 'not found' }, 404);
    });

    await expect(resolveOpenCodeAttachCliDialect({
      baseUrl: BASE_URL,
      fetchFn: fetchFn as unknown as typeof fetch,
    })).resolves.toBe('v1');
  });

  it('does not invent a v1 dialect when every generation probe is unauthorized', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 401 }));

    await expect(resolveOpenCodeAttachCliDialect({
      baseUrl: BASE_URL,
      fetchFn: fetchFn as unknown as typeof fetch,
    })).rejects.toThrow('neither authenticated V2 nor V1 health contract is available');
  });

  it('trusts an explicit V2 CLI selection without probing', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}));

    await expect(resolveOpenCodeAttachCliDialect({
      baseUrl: BASE_URL,
      launchApiGeneration: 'v2',
      fetchFn: fetchFn as unknown as typeof fetch,
    })).resolves.toBe('v2');

    expect(fetchFn).not.toHaveBeenCalled();
  });
});
