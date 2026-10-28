import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOpenCodeServerRuntimeClient } from './client';

type FakeResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

function createOkJsonResponse(body: unknown): FakeResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('createOpenCodeServerRuntimeClient (MCP)', () => {
  const prevEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    for (const key of ['HAPPIER_OPENCODE_SERVER_URL', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME'] as const) {
      prevEnv[key] = process.env[key];
    }

    process.env.HAPPIER_OPENCODE_SERVER_URL = 'http://127.0.0.1:9999';
    delete process.env.OPENCODE_SERVER_PASSWORD;
    delete process.env.OPENCODE_SERVER_USERNAME;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) {
        delete (process.env as any)[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('POSTs to /mcp with directory query and JSON body', async () => {
    const fetchSpy = vi.fn(async (url: any, _init?: any) => createOkJsonResponse(
      new URL(String(url)).pathname === '/global/health'
        ? { healthy: true, version: '1.2.15' }
        : { 'my-mcp': { status: 'connected' } },
    ) as any);
    vi.stubGlobal('fetch', fetchSpy as any);

    const client = await createOpenCodeServerRuntimeClient({ directory: '/tmp', messageBuffer: { push: () => {} } as any });
    await expect(client.mcpAdd({
      name: 'my-mcp',
      config: { type: 'local', enabled: true },
    })).resolves.toEqual({ status: 'connected' });

    const lastCall = fetchSpy.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const [url, init] = lastCall!;

    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe('/mcp');
    expect(parsed.searchParams.get('directory')).toBe('/tmp');

    expect((init as any).method).toBe('POST');
    expect((init as any).headers?.['content-type']).toBe('application/json');
    expect(JSON.parse(String((init as any).body))).toEqual({
      name: 'my-mcp',
      config: { type: 'local', enabled: true },
    });
  });

  it('returns the named MCP failure status from an HTTP 200 response', async () => {
    const fetchSpy = vi.fn(async (url: any) => createOkJsonResponse(
      new URL(String(url)).pathname === '/global/health'
        ? { healthy: true, version: '1.2.15' }
        : { happier: { status: 'failed', error: 'bridge startup failed' } },
    ) as any);
    vi.stubGlobal('fetch', fetchSpy as any);

    const client = await createOpenCodeServerRuntimeClient({
      directory: '/tmp',
      messageBuffer: { push: () => {} } as any,
    });

    await expect(client.mcpAdd({
      name: 'happier',
      config: { type: 'local', enabled: true },
    })).resolves.toEqual({
      status: 'failed',
      error: 'bridge startup failed',
    });
  });

  it('disconnects the exact V1 MCP name in its registration directory', async () => {
    const fetchSpy = vi.fn(async (url: any, _init?: any) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/global/health') {
        return createOkJsonResponse({ healthy: true, version: '1.2.15' }) as any;
      }
      if (parsed.pathname.endsWith('/disconnect')) {
        return {
          ok: true,
          status: 204,
          statusText: 'No Content',
          json: async () => undefined,
          text: async () => '',
        } as any;
      }
      return createOkJsonResponse({}) as any;
    });
    vi.stubGlobal('fetch', fetchSpy as any);

    const client = await createOpenCodeServerRuntimeClient({
      directory: '/tmp',
      messageBuffer: { push: () => {} } as any,
    });
    await client.mcpDisconnect({ directory: '/tmp/resumed', name: 'happier-session-a--custom' });

    const [url, init] = fetchSpy.mock.calls.at(-1)!;
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe('/mcp/happier-session-a--custom/disconnect');
    expect(parsed.searchParams.get('directory')).toBe('/tmp/resumed');
    expect((init as any).method).toBe('POST');
  });

});
