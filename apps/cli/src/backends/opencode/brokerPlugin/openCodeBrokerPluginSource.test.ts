import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OPEN_CODE_BROKER_STATE_PATH_ENV,
  OPEN_CODE_BROKER_PLUGIN_VERSION,
  OPEN_CODE_BROKER_SELECTIONS_ENV,
  buildOpenCodeBrokerMarker,
  buildOpenCodeBrokerPluginSource,
  buildOpenCodeBrokerV2PluginSource,
  serializeOpenCodeBrokerSelections,
} from './index';
import { deriveConnectedServiceBrokerRefreshToken } from '@/daemon/connectedServices/broker/brokerRefreshCapabilityToken';

const REFRESH_TOKEN_SENTINEL = 'refresh-token-MUST-NOT-LEAK';
const MASTER_CONTROL_TOKEN_SENTINEL = 'master-control-token-MUST-NOT-LEAK';

type BrokerHooks = {
  factory: () => Promise<{ auth: { provider: string; loader: BrokerHooks['loader'] } }>;
  loader: (getAuth: () => Promise<unknown>) => Promise<Record<string, unknown>>;
  provider: string;
  raw: Record<string, unknown>;
};

async function loadBrokerPlugin(provider: 'openai' | 'anthropic'): Promise<BrokerHooks> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-broker-plugin-'));
  const file = join(dir, `broker-${provider}-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(file, buildOpenCodeBrokerPluginSource(provider), 'utf8');
  const mod = await import(pathToFileURL(file).href);
  const factory = mod.default as BrokerHooks['factory'];
  const hooks = await factory();
  return {
    factory,
    loader: hooks.auth.loader,
    provider: hooks.auth.provider,
    raw: hooks as unknown as Record<string, unknown>,
  };
}

type V2HookEvent = { baseURL?: string; request?: Request; response?: Response };
type V2Hook = (event: V2HookEvent) => Promise<void> | void;

async function loadV2BrokerPlugin(provider: 'openai' | 'anthropic'): Promise<{
  id: string;
  setup: (context: {
    session: {
      hook: (name: string, callback: V2Hook, options?: { providerID?: string }) => Promise<void>;
    };
  }) => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-broker-plugin-v2-'));
  const file = join(dir, `broker-${provider}-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(file, buildOpenCodeBrokerV2PluginSource(provider), 'utf8');
  const mod = await import(pathToFileURL(file).href);
  return mod.default;
}

async function writeBrokerStateFile(token: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-broker-daemon-'));
  const file = join(dir, 'connected-service-broker.state.json');
  await writeFile(file, JSON.stringify({
    httpPort: 51999,
    connectedServiceBrokerRefreshToken: deriveConnectedServiceBrokerRefreshToken(token),
  }), 'utf8');
  return file;
}

describe('openCodeBrokerPluginSource (generated artifact, exercised live)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    delete process.env[OPEN_CODE_BROKER_SELECTIONS_ENV];
    delete process.env[OPEN_CODE_BROKER_STATE_PATH_ENV];
    delete process.env.HAPPIER_OPENCODE_BROKER_LOAD_NONCE;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env[OPEN_CODE_BROKER_SELECTIONS_ENV];
    delete process.env[OPEN_CODE_BROKER_STATE_PATH_ENV];
    delete process.env.HAPPIER_OPENCODE_BROKER_LOAD_NONCE;
  });

  it('engages only on its exact provider/version marker', async () => {
    const { loader, provider } = await loadBrokerPlugin('openai');
    expect(provider).toBe('openai');

    const directKey = await loader(async () => ({ type: 'api', key: 'sk-real-openai-key' }));
    expect(directKey).toEqual({});
    expect(await loader(async () => ({
      type: 'api',
      key: buildOpenCodeBrokerMarker('openai', '2'),
    }))).toEqual({});
    expect(await loader(async () => ({
      type: 'api',
      key: buildOpenCodeBrokerMarker('anthropic', OPEN_CODE_BROKER_PLUGIN_VERSION),
    }))).toEqual({});

    const marker = buildOpenCodeBrokerMarker('openai', OPEN_CODE_BROKER_PLUGIN_VERSION);
    const brokered = await loader(async () => ({ type: 'api', key: marker }));
    expect(typeof brokered.fetch).toBe('function');
    expect(brokered.apiKey).toBe(marker);
  });

  it('V2 exports the released definition ABI and applies broker auth through provider-scoped request hooks', async () => {
    process.env[OPEN_CODE_BROKER_STATE_PATH_ENV] = await writeBrokerStateFile('daemon-control');
    process.env[OPEN_CODE_BROKER_SELECTIONS_ENV] = serializeOpenCodeBrokerSelections({
      openai: { serviceId: 'openai-codex', profileId: 'codex-pro', accountId: null, planType: 'pro' },
    });

    const bridgeBodies: Array<Record<string, unknown>> = [];
    const providerRequests: Request[] = [];
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/chatgpt-auth-tokens/refresh')) {
        bridgeBodies.push(JSON.parse(String(init?.body ?? '{}')));
        return new Response(JSON.stringify({
          ok: true,
          result: { accessToken: `broker-access-${bridgeBodies.length}`, chatgptAccountId: 'acct_v2' },
        }), { status: 200 });
      }
      if (url.includes('/connected-service-auth/broker/loaded')) {
        return new Response('{}', { status: 200 });
      }
      const request = input instanceof Request ? input : new Request(input, init);
      providerRequests.push(request);
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const plugin = await loadV2BrokerPlugin('openai');
    expect(plugin.id).toBe('happier-broker-openai');
    expect(typeof plugin.setup).toBe('function');

    const hooks = new Map<string, V2Hook>();
    await plugin.setup({
      session: {
        hook: async (name, callback, options) => {
          expect(options).toEqual({ providerID: 'openai' });
          hooks.set(name, callback);
        },
      },
    });

    const modelEvent: V2HookEvent = { baseURL: 'https://api.openai.com/v1' };
    await hooks.get('model.request')?.(modelEvent);
    expect(modelEvent.baseURL).toBe('https://chatgpt.com/backend-api');

    const requestEvent: V2HookEvent = {
      request: new Request('https://chatgpt.com/backend-api/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'native-key-MUST-NOT-LEAK' },
        body: JSON.stringify({ model: 'gpt-5-codex', input: [] }),
      }),
    };
    await hooks.get('http.request')?.(requestEvent);
    expect(requestEvent.request?.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(requestEvent.request?.headers.get('authorization')).toBe('Bearer broker-access-1');
    expect(requestEvent.request?.headers.get('x-api-key')).toBeNull();

    const responseEvent: V2HookEvent = {
      request: requestEvent.request,
      response: new Response('unauthorized', { status: 401 }),
    };
    await hooks.get('http.response')?.(responseEvent);
    expect(responseEvent.response?.status).toBe(200);
    expect(bridgeBodies).toHaveLength(2);
    expect(bridgeBodies[0]).toMatchObject({ forceRefresh: false });
    expect(bridgeBodies[1]).toMatchObject({ forceRefresh: true });
    expect(providerRequests).toHaveLength(1);
    expect(providerRequests[0]?.headers.get('authorization')).toBe('Bearer broker-access-2');
    expect(await providerRequests[0]?.clone().text()).not.toContain('native-key-MUST-NOT-LEAK');
  });

  it('Codex: fetches the access token from the daemon bridge and shapes the request (no refresh token anywhere)', async () => {
    // The provider-visible descriptor contains only the endpoint and narrow capability.
    process.env[OPEN_CODE_BROKER_STATE_PATH_ENV] = await writeBrokerStateFile(MASTER_CONTROL_TOKEN_SENTINEL);
    process.env[OPEN_CODE_BROKER_SELECTIONS_ENV] = serializeOpenCodeBrokerSelections({
      openai: { serviceId: 'openai-codex', profileId: 'codex-pro', accountId: null, planType: 'pro' },
    });

    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    globalThis.fetch = vi.fn(async (input: unknown, init: unknown) => {
      const url = String(input);
      const reqInit = (init ?? {}) as RequestInit;
      calls.push({ url, headers: new Headers(reqInit.headers ?? {}), body: String(reqInit.body ?? '') });
      if (url.includes('/chatgpt-auth-tokens/refresh')) {
        return new Response(
          JSON.stringify({ ok: true, result: { accessToken: 'fresh-access-token', chatgptAccountId: 'acct_99', chatgptPlanType: 'pro' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const { loader } = await loadBrokerPlugin('openai');
    const result = await loader(async () => ({
      type: 'api',
      key: buildOpenCodeBrokerMarker('openai', OPEN_CODE_BROKER_PLUGIN_VERSION),
    }));
    // The loader pins the Codex backend base URL so the AI SDK builds <baseURL>/responses.
    expect(result.baseURL).toBe('https://chatgpt.com/backend-api');
    const brokeredFetch = result.fetch as (input: string, init: RequestInit) => Promise<Response>;

    await brokeredFetch('https://chatgpt.com/backend-api/responses', {
      method: 'POST',
      headers: { 'x-api-key': REFRESH_TOKEN_SENTINEL, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5-codex', input: [] }),
    });

    const bridgeCall = calls.find((c) => c.url.includes('/chatgpt-auth-tokens/refresh'));
    expect(bridgeCall).toBeDefined();
    expect(bridgeCall!.url).toBe('http://127.0.0.1:51999/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh');
    // The scoped token (NOT the master) is sent; the master must never appear on the wire.
    expect(bridgeCall!.headers.get('x-happier-daemon-token')).toBe(deriveConnectedServiceBrokerRefreshToken(MASTER_CONTROL_TOKEN_SENTINEL));
    expect(bridgeCall!.headers.get('x-happier-daemon-token')).not.toBe(MASTER_CONTROL_TOKEN_SENTINEL);
    expect(JSON.parse(bridgeCall!.body)).toMatchObject({ selection: { kind: 'profile', serviceId: 'openai-codex', profileId: 'codex-pro' } });

    const providerCall = calls.find((c) => c.url.includes('chatgpt.com/backend-api'));
    expect(providerCall).toBeDefined();
    expect(providerCall!.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(providerCall!.headers.get('authorization')).toBe('Bearer fresh-access-token');
    expect(providerCall!.headers.get('chatgpt-account-id')).toBe('acct_99');
    expect(providerCall!.headers.get('openai-beta')).toBe('responses=experimental');
    expect(providerCall!.headers.get('originator')).toBe('codex_cli_rs');
    expect(providerCall!.headers.get('x-api-key')).toBeNull();
    const providerBody = JSON.parse(providerCall!.body);
    expect(providerBody.model).toBe('gpt-5.1-codex');
    expect(providerBody.include).toContain('reasoning.encrypted_content');

    // No-leak: nothing the broker ever transmits contains the refresh-token OR the master control token.
    for (const call of calls) {
      expect(call.body).not.toContain(REFRESH_TOKEN_SENTINEL);
      expect(call.body).not.toContain(MASTER_CONTROL_TOKEN_SENTINEL);
      for (const [, value] of call.headers.entries()) {
        expect(value).not.toContain(REFRESH_TOKEN_SENTINEL);
        expect(value).not.toContain(MASTER_CONTROL_TOKEN_SENTINEL);
      }
    }
  });

  it('Codex: on a 401 it forces one bridge refresh (forceRefresh flag) and retries; the first call does NOT force', async () => {
    process.env[OPEN_CODE_BROKER_STATE_PATH_ENV] = await writeBrokerStateFile('tok');
    process.env[OPEN_CODE_BROKER_SELECTIONS_ENV] = serializeOpenCodeBrokerSelections({
      openai: { serviceId: 'openai-codex', profileId: 'p', accountId: 'a', planType: null },
    });
    let bridgeCalls = 0;
    let providerCalls = 0;
    const bridgeBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (input: unknown, init: unknown) => {
      const url = String(input);
      if (url.includes('/chatgpt-auth-tokens/refresh')) {
        bridgeCalls += 1;
        bridgeBodies.push(JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')));
        return new Response(JSON.stringify({ ok: true, result: { accessToken: `access-${bridgeCalls}`, chatgptAccountId: 'a' } }), { status: 200 });
      }
      providerCalls += 1;
      return new Response('x', { status: providerCalls === 1 ? 401 : 200 });
    }) as unknown as typeof fetch;

    const { loader } = await loadBrokerPlugin('openai');
    const result = await loader(async () => ({
      type: 'api',
      key: buildOpenCodeBrokerMarker('openai', OPEN_CODE_BROKER_PLUGIN_VERSION),
    }));
    const brokeredFetch = result.fetch as (input: string, init: RequestInit) => Promise<Response>;
    const response = await brokeredFetch('https://api.openai.com/v1/responses', { method: 'POST', body: '{}' });

    expect(response.status).toBe(200);
    expect(bridgeCalls).toBe(2);
    expect(providerCalls).toBe(2);
    // F6: the cold fetch does NOT force a rotation; only the 401-retry path forces.
    expect(bridgeBodies[0]).toMatchObject({ forceRefresh: false });
    expect(bridgeBodies[1]).toMatchObject({ forceRefresh: true });
  });

  it('pings the daemon load-handshake endpoint with the scoped token on plugin activation (F4)', async () => {
    process.env[OPEN_CODE_BROKER_STATE_PATH_ENV] = await writeBrokerStateFile(MASTER_CONTROL_TOKEN_SENTINEL);
    process.env[OPEN_CODE_BROKER_SELECTIONS_ENV] = serializeOpenCodeBrokerSelections({
      openai: { serviceId: 'openai-codex', profileId: 'codex-pro', accountId: null, planType: 'pro' },
      anthropic: { serviceId: 'claude-subscription', profileId: 'claude-pro', accountId: null, planType: null },
    });
    const selectionIdentity = `opencode|connected|broker:${OPEN_CODE_BROKER_PLUGIN_VERSION}|openai-codex:codex-pro:`;
    process.env.HAPPIER_OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY = selectionIdentity;
    process.env.HAPPIER_OPENCODE_BROKER_LOAD_NONCE = 'opencode-spawn-1';
    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    globalThis.fetch = vi.fn(async (input: unknown, init: unknown) => {
      const url = String(input);
      const reqInit = (init ?? {}) as RequestInit;
      calls.push({ url, headers: new Headers(reqInit.headers ?? {}), body: String(reqInit.body ?? '') });
      return new Response(JSON.stringify({ ok: true, result: { acknowledged: true } }), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      // Activating the plugin (calling the factory) must register the load handshake with the daemon.
      await loadBrokerPlugin('openai');
      // The handshake is best-effort + bounded; let the microtask/0ms timer flush.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const handshake = calls.find((c) => c.url.includes('/connected-service-auth/broker/loaded'));
      expect(handshake).toBeDefined();
      expect(handshake!.url).toBe('http://127.0.0.1:51999/connected-service-auth/broker/loaded');
      expect(handshake!.headers.get('x-happier-daemon-token')).toBe(deriveConnectedServiceBrokerRefreshToken(MASTER_CONTROL_TOKEN_SENTINEL));
      const body = JSON.parse(handshake!.body);
      expect(body.selectionIdentity).toBe(selectionIdentity);
      expect(body.loadNonce).toBe('opencode-spawn-1');
      // Every generated provider leaf reports the complete managed-child provider set so the
      // handshake producer can durably bind one exact generation without waiting for later status
      // polling to aggregate process-local observations.
      expect(body.providers).toEqual(['openai', 'anthropic']);
      // No-leak: the handshake never carries the MASTER control token (header or body).
      expect(handshake!.headers.get('x-happier-daemon-token')).not.toBe(MASTER_CONTROL_TOKEN_SENTINEL);
      expect(handshake!.body).not.toContain(MASTER_CONTROL_TOKEN_SENTINEL);
    } finally {
      delete process.env.HAPPIER_OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY;
      delete process.env.HAPPIER_OPENCODE_BROKER_LOAD_NONCE;
    }
  });

  it('does not consume the one-shot handshake until the daemon acknowledges durable activation proof', async () => {
    process.env[OPEN_CODE_BROKER_STATE_PATH_ENV] = await writeBrokerStateFile('tok');
    process.env[OPEN_CODE_BROKER_SELECTIONS_ENV] = serializeOpenCodeBrokerSelections({
      openai: { serviceId: 'openai-codex', profileId: 'p', accountId: null, planType: null },
    });
    process.env.HAPPIER_OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY =
      `opencode|connected|broker:${OPEN_CODE_BROKER_PLUGIN_VERSION}|openai-codex:p:`;
    process.env.HAPPIER_OPENCODE_BROKER_LOAD_NONCE = 'opencode-spawn-retry';
    let handshakeCalls = 0;
    globalThis.fetch = vi.fn(async (input: unknown) => {
      if (String(input).includes('/connected-service-auth/broker/loaded')) {
        handshakeCalls += 1;
        return new Response('{}', { status: handshakeCalls === 1 ? 503 : 200 });
      }
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const { factory } = await loadBrokerPlugin('openai');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(handshakeCalls).toBe(1);

      // OpenCode may invoke the plugin factory again. A rejected durability boundary must leave the
      // same generated one-shot eligible; the successful second acknowledgement consumes it.
      await factory();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(handshakeCalls).toBe(2);

      await factory();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(handshakeCalls).toBe(2);
    } finally {
      delete process.env.HAPPIER_OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY;
      delete process.env.HAPPIER_OPENCODE_BROKER_LOAD_NONCE;
    }
  });

  it('Anthropic: uses Bearer + anthropic-beta, deletes x-api-key, and injects the Claude Code system identity', async () => {
    process.env[OPEN_CODE_BROKER_STATE_PATH_ENV] = await writeBrokerStateFile('tok');
    process.env[OPEN_CODE_BROKER_SELECTIONS_ENV] = serializeOpenCodeBrokerSelections({
      anthropic: { serviceId: 'claude-subscription', profileId: 'claude-pro', accountId: null, planType: null },
    });
    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    globalThis.fetch = vi.fn(async (input: unknown, init: unknown) => {
      const url = String(input);
      const reqInit = (init ?? {}) as RequestInit;
      calls.push({ url, headers: new Headers(reqInit.headers ?? {}), body: String(reqInit.body ?? '') });
      if (url.includes('/anthropic-auth-tokens/refresh')) {
        return new Response(JSON.stringify({ ok: true, result: { accessToken: 'claude-access', expiresAt: Date.now() + 3_600_000 } }), { status: 200 });
      }
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const { loader, provider } = await loadBrokerPlugin('anthropic');
    expect(provider).toBe('anthropic');
    const result = await loader(async () => ({
      type: 'api',
      key: buildOpenCodeBrokerMarker('anthropic', OPEN_CODE_BROKER_PLUGIN_VERSION),
    }));
    const brokeredFetch = result.fetch as (input: string, init: RequestInit) => Promise<Response>;

    await brokeredFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': REFRESH_TOKEN_SENTINEL },
      body: JSON.stringify({ model: 'claude-x', system: 'Be helpful', messages: [] }),
    });

    const providerCall = calls.find((c) => c.url.includes('api.anthropic.com'));
    expect(providerCall).toBeDefined();
    expect(providerCall!.headers.get('authorization')).toBe('Bearer claude-access');
    expect(providerCall!.headers.get('anthropic-beta')).toContain('oauth-2025-04-20');
    expect(providerCall!.headers.get('x-api-key')).toBeNull();
    const body = JSON.parse(providerCall!.body);
    const firstSystem = Array.isArray(body.system) ? body.system[0] : body.system;
    expect(firstSystem.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    for (const call of calls) expect(call.body).not.toContain(REFRESH_TOKEN_SENTINEL);
  });
});
