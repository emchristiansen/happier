import {
  CONNECTED_SERVICE_BROKER_LOADED_HANDSHAKE_PATH,
  buildBrokerBridgeCallSource,
} from '@/daemon/connectedServices/broker/brokerBridgeCallSource';
import {
  CLAUDE_SUBSCRIPTION_AUTH_TOKENS_REFRESH_PATH,
  CLAUDE_SUBSCRIPTION_AUTH_TOKENS_REFRESH_SERVICE_ID,
} from '@/backends/claude/connectedServices/claudeSubscriptionAuthTokensRefreshBridgeContract';
import {
  CODEX_CHATGPT_AUTH_TOKENS_REFRESH_PATH,
  CODEX_CHATGPT_AUTH_TOKENS_REFRESH_SERVICE_ID,
} from '@/backends/codex/connectedServices/codexChatGptAuthTokensRefreshBridgeContract';

import {
  OPEN_CODE_BROKER_STATE_PATH_ENV,
  OPEN_CODE_BROKER_LOAD_NONCE_ENV,
  OPEN_CODE_BROKER_PLUGIN_VERSION_ENV,
  OPEN_CODE_BROKER_SELECTIONS_ENV,
  OPEN_CODE_BROKER_SELECTION_IDENTITY_ENV,
  buildOpenCodeBrokerMarker,
  type OpenCodeBrokerProvider,
} from './openCodeBrokerPluginEnv';

/**
 * First publishable version of the Happier OpenCode auth broker plugin. It is folded into the
 * broker marker + selection identity so a future breaking plugin revision yields a new
 * managed-server fingerprint. The generated filename is deliberately stable: OpenCode auto-loads
 * every plugin in its directory, so versioned sibling files must never coexist there.
 */
export const OPEN_CODE_BROKER_PLUGIN_VERSION = '1';

/** Canonical Codex backend constants (replicated from the official Codex CLI request shape). */
export const OPEN_CODE_BROKER_CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
export const OPEN_CODE_BROKER_CODEX_RESPONSES_FROM = '/responses';
export const OPEN_CODE_BROKER_CODEX_RESPONSES_TO = '/codex/responses';
export const OPEN_CODE_BROKER_CODEX_ORIGINATOR = 'codex_cli_rs';
export const OPEN_CODE_BROKER_CODEX_OPENAI_BETA = 'responses=experimental';

/** Canonical Anthropic OAuth constants. */
export const OPEN_CODE_BROKER_ANTHROPIC_BETA = 'oauth-2025-04-20';
export const OPEN_CODE_BROKER_ANTHROPIC_SYSTEM_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Daemon bridge paths the broker calls to obtain fresh access tokens (daemon = sole refresher). These
 * come from provider-owned bridge contracts so the generated broker artifact cannot drift from the
 * daemon endpoint schemas.
 */
export const OPEN_CODE_BROKER_CODEX_BRIDGE_PATH = CODEX_CHATGPT_AUTH_TOKENS_REFRESH_PATH;
export const OPEN_CODE_BROKER_ANTHROPIC_BRIDGE_PATH = CLAUDE_SUBSCRIPTION_AUTH_TOKENS_REFRESH_PATH;

/**
 * Load-handshake path (F4): the broker pings this once on activation so the daemon can record that the
 * plugin actually loaded in the OpenCode runtime. The preflight verifies the handshake before the
 * first connected prompt; the file-existence + non-functional marker remain the backstop. Shared with
 * the Pi extension (the daemon registry is keyed by stable selection identity plus per-spawn load nonce,
 * not by provider).
 */
export const OPEN_CODE_BROKER_LOADED_HANDSHAKE_PATH = CONNECTED_SERVICE_BROKER_LOADED_HANDSHAKE_PATH;

function jsString(value: string): string {
  return JSON.stringify(value);
}

function resolveOpenCodeBrokerBridgeParams(provider: OpenCodeBrokerProvider) {
  if (provider === 'openai') {
    return {
      providerTag: provider,
      bridgePath: CODEX_CHATGPT_AUTH_TOKENS_REFRESH_PATH,
      serviceId: CODEX_CHATGPT_AUTH_TOKENS_REFRESH_SERVICE_ID,
      planTypeBodyField: 'chatgptPlanType',
      accountIdResultFields: ['accountId', 'chatgptAccountId'] as const,
    };
  }
  return {
    providerTag: provider,
    bridgePath: CLAUDE_SUBSCRIPTION_AUTH_TOKENS_REFRESH_PATH,
    serviceId: CLAUDE_SUBSCRIPTION_AUTH_TOKENS_REFRESH_SERVICE_ID,
    accountIdResultFields: ['accountId', 'anthropicAccountId'] as const,
  };
}

/**
 * Shared broker payload JS: model normalization, token cache, Codex/Anthropic shaping, and the
 * load handshake. Single owner for both generations: V1 (auth loader + brokeredFetch) and V2
 * (session hooks) embed this identical snippet so there is exactly one request-auth policy. The
 * snippet expects the wrapper to define PROVIDER and BRIDGE facts (via the shared bridge builder)
 * plus SELECTION_IDENTITY_ENV, LOAD_NONCE_ENV, LOADED_HANDSHAKE_PATH, MARKER, Codex and Anthropic constants.
 * It defines MODEL_MAP, normalizeCodexModel, getAccessToken, rewriteCodexUrl, buildCodexHeaders,
 * transformCodexBody, buildAnthropicHeaders, injectAnthropicSystemIdentity, sendLoadHandshake.
 * V1 adds brokeredFetch + the legacy auth factory; V2 adds session-hook registration. No global
 * env fallback and no user-DB reads: the daemon bridge is the sole credential authority.
 */
function buildOpenCodeBrokerSharedPayloadJs(): string {
  return `// Static, binary-safe model normalization (subset of the official Codex CLI map). No remote fetch.
const MODEL_MAP = {
  "gpt-5": "gpt-5.1",
  "gpt-5-codex": "gpt-5.1-codex",
  "gpt-5-codex-mini": "gpt-5.1-codex-mini",
  "codex-mini-latest": "gpt-5.1-codex-mini",
  "gpt-5.1": "gpt-5.1",
  "gpt-5.1-codex": "gpt-5.1-codex",
  "gpt-5.1-codex-max": "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini": "gpt-5.1-codex-mini",
  "gpt-5.2": "gpt-5.2",
  "gpt-5.2-codex": "gpt-5.2-codex",
};

function normalizeCodexModel(model) {
  if (typeof model !== "string" || model.length === 0) return model;
  const bare = model.includes("/") ? model.split("/").pop() : model;
  if (MODEL_MAP[bare]) return MODEL_MAP[bare];
  const lower = String(bare).toLowerCase();
  for (const key of Object.keys(MODEL_MAP)) {
    if (key.toLowerCase() === lower) return MODEL_MAP[key];
    if (lower.startsWith(key.toLowerCase() + "-")) return MODEL_MAP[key];
  }
  return bare;
}

// In-memory access-token cache. Refresh ~60s before expiry; fixed conservative TTL when expiry unknown.
const DEFAULT_TTL_MS = 45 * 60 * 1000;
const EXPIRY_SKEW_MS = 60 * 1000;
let cached = null;
let inFlight = null;

async function getAccessToken(forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && cached && cached.notAfter > now && cached.selectionEpoch === null) return cached;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const failingAccessToken = forceRefresh === true && cached ? cached.accessToken : null;
    const fresh = await fetchAccessTokenFromBridge(forceRefresh === true, failingAccessToken);
    const notAfter = fresh.expiresAt && fresh.expiresAt > now
      ? fresh.expiresAt - EXPIRY_SKEW_MS
      : now + DEFAULT_TTL_MS;
    cached = { accessToken: fresh.accessToken, accountId: fresh.accountId, notAfter: notAfter, selectionEpoch: fresh.selectionEpoch };
    return cached;
  })();
  try { return await inFlight; } finally { inFlight = null; }
}

function rewriteCodexUrl(url) {
  return String(url).replace(CODEX_FROM, CODEX_TO);
}

function buildCodexHeaders(init, accountId, accessToken) {
  const headers = new Headers(init && init.headers ? init.headers : {});
  headers.delete("x-api-key");
  headers.set("Authorization", "Bearer " + accessToken);
  if (accountId) headers.set("chatgpt-account-id", accountId);
  headers.set("OpenAI-Beta", CODEX_OPENAI_BETA);
  headers.set("originator", CODEX_ORIGINATOR);
  const cacheKey = init && init.__promptCacheKey ? init.__promptCacheKey : null;
  if (cacheKey) { headers.set("conversation_id", cacheKey); headers.set("session_id", cacheKey); }
  else { headers.delete("conversation_id"); headers.delete("session_id"); }
  headers.set("accept", "text/event-stream");
  return headers;
}

function transformCodexBody(init) {
  if (!init || !init.body || typeof init.body !== "string") return { init: init, promptCacheKey: null };
  let body;
  try { body = JSON.parse(init.body); } catch { return { init: init, promptCacheKey: null }; }
  if (typeof body.model === "string") body.model = normalizeCodexModel(body.model);
  body.store = false;
  const include = Array.isArray(body.include) ? body.include.slice() : [];
  if (include.indexOf("reasoning.encrypted_content") === -1) include.push("reasoning.encrypted_content");
  body.include = include;
  const promptCacheKey = typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : null;
  return { init: Object.assign({}, init, { body: JSON.stringify(body) }), promptCacheKey: promptCacheKey };
}

function buildAnthropicHeaders(init, accessToken) {
  const headers = new Headers(init && init.headers ? init.headers : {});
  headers.delete("x-api-key");
  headers.set("Authorization", "Bearer " + accessToken);
  const existingBeta = headers.get("anthropic-beta");
  headers.set("anthropic-beta", existingBeta && existingBeta.indexOf(ANTHROPIC_BETA) === -1
    ? existingBeta + "," + ANTHROPIC_BETA
    : ANTHROPIC_BETA);
  if (!headers.get("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  return headers;
}

function injectAnthropicSystemIdentity(init) {
  if (!init || !init.body || typeof init.body !== "string") return init;
  let body;
  try { body = JSON.parse(init.body); } catch { return init; }
  const identity = { type: "text", text: ANTHROPIC_SYSTEM_IDENTITY };
  if (Array.isArray(body.system)) {
    const first = body.system[0];
    const firstText = first && typeof first.text === "string" ? first.text : (typeof first === "string" ? first : "");
    if (firstText !== ANTHROPIC_SYSTEM_IDENTITY) body.system = [identity].concat(body.system);
  } else if (typeof body.system === "string" && body.system.length > 0) {
    if (body.system !== ANTHROPIC_SYSTEM_IDENTITY) body.system = [identity, { type: "text", text: body.system }];
  } else {
    body.system = [identity];
  }
  return Object.assign({}, init, { body: JSON.stringify(body) });
}

// Best-effort, bounded load handshake (F4): tell the daemon this broker plugin actually loaded in the
// OpenCode runtime, keyed by the stable selection identity so the preflight (same env) can match it.
// Never throws and never blocks the plugin: failures are swallowed (the file-existence + non-functional
// marker remain the fail-closed backstop).
let handshakeSent = false;
async function sendLoadHandshake() {
  if (handshakeSent) return;
  try {
    const selectionIdentity = process.env[SELECTION_IDENTITY_ENV];
    if (typeof selectionIdentity !== "string" || selectionIdentity.trim().length === 0) return;
    const loadNonce = process.env[LOAD_NONCE_ENV];
    if (typeof loadNonce !== "string" || loadNonce.trim().length === 0) return;
    const selections = readJsonEnv(SELECTIONS_ENV) || {};
    const providers = ["openai", "anthropic"].filter((provider) => selections[provider]);
    if (providers.length === 0) return;
    const daemonEndpoint = readCurrentBrokerEndpoint();
    const response = await fetch("http://127.0.0.1:" + daemonEndpoint.httpPort + LOADED_HANDSHAKE_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-happier-daemon-token": daemonEndpoint.scopedToken },
      body: JSON.stringify({
        runtimeKind: "opencode_managed_server",
        selectionIdentity: selectionIdentity,
        loadNonce: loadNonce,
        providers: providers,
        pluginVersion: process.env[PLUGIN_VERSION_ENV] || PLUGIN_VERSION,
        processPid: process.pid,
      }),
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(2000) : undefined,
    });
    // Only the daemon's durable managed-child acknowledgement consumes this one-shot signal. A
    // failed request remains eligible if OpenCode invokes the plugin factory again; no retry owner,
    // timer, or heartbeat is introduced here.
    if (response.ok) handshakeSent = true;
  } catch (error) {
    // Swallow: auth still flows via the loader + bridge, and a later factory invocation can retry.
  }
}`;
}

/**
 * Build the self-contained ESM source for the Happier OpenCode auth broker plugin for one provider.
 *
 * The returned string is written to disk and loaded by OpenCode's own Bun runtime as a local
 * plugin file. It imports NOTHING (no Happier modules, no npm deps) and uses only Bun/Node globals
 * (`fetch`, `process`, `node:fs`). It:
 *   - engages on Happier's broker auth marker (NOT on real provider tokens),
 *   - obtains a fresh ACCESS token from the Happier daemon bridge over local HTTP (the daemon is the
 *     sole refresher; NO refresh token is ever present here),
 *   - reads one matching daemon port + scoped capability snapshot from broker-state at call time,
 *   - shapes the provider request (Codex backend rewrite + headers, or Anthropic Bearer+beta),
 *   - caches the access token in-memory and refreshes once on a 401.
 */
function buildOpenCodeBrokerBridgeCallSourceFor(provider: OpenCodeBrokerProvider): string {
  const bridgeParams = resolveOpenCodeBrokerBridgeParams(provider);
  return buildBrokerBridgeCallSource({
    ...bridgeParams,
    selectionsEnv: OPEN_CODE_BROKER_SELECTIONS_ENV,
    brokerStatePathEnv: OPEN_CODE_BROKER_STATE_PATH_ENV,
    pluginVersionEnv: OPEN_CODE_BROKER_PLUGIN_VERSION_ENV,
    pluginVersion: OPEN_CODE_BROKER_PLUGIN_VERSION,
    sessionTag: 'opencode-broker',
    selectionIdentityEnv: OPEN_CODE_BROKER_SELECTION_IDENTITY_ENV,
  });
}

/**
 * Build the self-contained ESM source for the Happier OpenCode auth broker plugin for one provider.
 *
 * V1 generation: legacy async factory `{ return { auth: { provider, methods, loader } } }` loaded
 * by OpenCode 1.x auto-discovery from `<XDG_CONFIG_HOME>/opencode/plugin/*.js`. Preserved
 * unchanged in behavior; now embeds the shared payload so V1/V2 share one policy.
 */
export function buildOpenCodeBrokerPluginSource(provider: OpenCodeBrokerProvider): string {
  const sharedBridgeCallSource = buildOpenCodeBrokerBridgeCallSourceFor(provider);
  const sharedPayload = buildOpenCodeBrokerSharedPayloadJs();
  return `// Happier OpenCode auth broker plugin (generated). Provider: ${provider}. Version: ${OPEN_CODE_BROKER_PLUGIN_VERSION}.
// Self-contained ESM: loaded by OpenCode's Bun runtime. No Happier imports, no npm deps.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

${sharedBridgeCallSource}

const SELECTION_IDENTITY_ENV = ${jsString(OPEN_CODE_BROKER_SELECTION_IDENTITY_ENV)};
const LOAD_NONCE_ENV = ${jsString(OPEN_CODE_BROKER_LOAD_NONCE_ENV)};
const LOADED_HANDSHAKE_PATH = ${jsString(OPEN_CODE_BROKER_LOADED_HANDSHAKE_PATH)};
const MARKER = ${jsString(buildOpenCodeBrokerMarker(provider, OPEN_CODE_BROKER_PLUGIN_VERSION))};

const CODEX_BASE_URL = ${jsString(OPEN_CODE_BROKER_CODEX_BASE_URL)};
const CODEX_FROM = ${jsString(OPEN_CODE_BROKER_CODEX_RESPONSES_FROM)};
const CODEX_TO = ${jsString(OPEN_CODE_BROKER_CODEX_RESPONSES_TO)};
const CODEX_ORIGINATOR = ${jsString(OPEN_CODE_BROKER_CODEX_ORIGINATOR)};
const CODEX_OPENAI_BETA = ${jsString(OPEN_CODE_BROKER_CODEX_OPENAI_BETA)};

const ANTHROPIC_BETA = ${jsString(OPEN_CODE_BROKER_ANTHROPIC_BETA)};
const ANTHROPIC_SYSTEM_IDENTITY = ${jsString(OPEN_CODE_BROKER_ANTHROPIC_SYSTEM_IDENTITY)};

${sharedPayload}

async function brokeredFetch(input, init) {
  const url = typeof input === "string" ? input : (input && input.url ? input.url : String(input));
  let token = await getAccessToken(false);
  const doRequest = async (accessToken, accountId) => {
    if (PROVIDER === "openai") {
      const transformed = transformCodexBody(init);
      const headers = buildCodexHeaders(
        Object.assign({}, transformed.init, { __promptCacheKey: transformed.promptCacheKey }),
        accountId,
        accessToken,
      );
      return fetch(rewriteCodexUrl(url), Object.assign({}, transformed.init, { headers: headers }));
    }
    const withIdentity = injectAnthropicSystemIdentity(init);
    const headers = buildAnthropicHeaders(withIdentity, accessToken);
    return fetch(url, Object.assign({}, withIdentity, { headers: headers }));
  };
  let response = await doRequest(token.accessToken, token.accountId);
  if (response.status === 401) {
    token = await getAccessToken(true);
    response = await doRequest(token.accessToken, token.accountId);
  }
  return response;
}

export const HappierOpenCodeAuthBrokerPlugin = async () => {
  // Register the load handshake without blocking activation.
  void sendLoadHandshake();
  return {
    auth: {
      provider: PROVIDER,
      methods: [],
      loader: async (getAuth) => {
        const auth = await getAuth().catch(() => null);
        const key = auth && typeof auth.key === "string" ? auth.key : "";
        // Engage only for this exact provider/revision. A stale generated sibling must never
        // shadow either the current broker or a real direct credential.
        if (key !== MARKER) return {};
        const result = { apiKey: key, fetch: brokeredFetch };
        // Codex requests must target the ChatGPT backend; the AI SDK builds <baseURL>/responses
        // which brokeredFetch then rewrites to <baseURL>/codex/responses.
        if (PROVIDER === "openai") result.baseURL = CODEX_BASE_URL;
        return result;
      },
    },
  };
};

export default HappierOpenCodeAuthBrokerPlugin;
`;
}

/**
 * Build the released-V2 (`opencode` 2.x) broker plugin source for one provider.
 *
 * Released module contract (`packages/core/src/plugin/module.ts` at 6f3639d): default must be
 * `{ id, setup }` (promise) or `{ id, effect }`. The legacy V1 async factory
 * `{ return { auth: { provider, methods, loader } } }` is rejected with
 * `Plugin must export a default definition with an id and an effect or setup function.`
 * This V2 bridge therefore registers `model.request` (Codex baseURL) + `http.request`
 * (daemon-bridge Bearer + Codex rewrite / Anthropic shaping) + `http.response` (single 401
 * refresh + retry) scoped to its providerID. It reuses the daemon bridge (sole refresher),
 * the shared payload (token cache, Codex/Anthropic shaping, handshake), and the same
 * Codex endpoint/body and Anthropic Bearer/headers semantics as V1. No global-env fallback,
 * no user-DB reads, no new credential authority/store/registry/retry budget.
 *
 * The module is written as a local plugin directory under `happier-v2-plugins/` and registered via
 * explicit config;
 * it is never auto-loaded from the V1 `opencode/plugin/` dir, so one module cannot load twice.
 * Native sessions have no V2 plugin and no hook, preserving native unbound isolation. Direct API
 * keys stay on `OPENCODE_AUTH_CONTENT` for V1 and are also materialized through V2's canonical
 * `providers.<id>.settings.apiKey` configuration. This bridge covers brokered subscription OAuth only.
 */
export function buildOpenCodeBrokerV2PluginSource(provider: OpenCodeBrokerProvider): string {
  const sharedBridgeCallSource = buildOpenCodeBrokerBridgeCallSourceFor(provider);
  const sharedPayload = buildOpenCodeBrokerSharedPayloadJs();
  return `// Happier OpenCode auth broker plugin (generated, V2). Provider: ${provider}. Version: ${OPEN_CODE_BROKER_PLUGIN_VERSION}.
// Self-contained ESM: loaded by released OpenCode 2.x via explicit config. No Happier imports, no npm deps.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

${sharedBridgeCallSource}

const SELECTION_IDENTITY_ENV = ${jsString(OPEN_CODE_BROKER_SELECTION_IDENTITY_ENV)};
const LOAD_NONCE_ENV = ${jsString(OPEN_CODE_BROKER_LOAD_NONCE_ENV)};
const LOADED_HANDSHAKE_PATH = ${jsString(OPEN_CODE_BROKER_LOADED_HANDSHAKE_PATH)};

const CODEX_BASE_URL = ${jsString(OPEN_CODE_BROKER_CODEX_BASE_URL)};
const CODEX_FROM = ${jsString(OPEN_CODE_BROKER_CODEX_RESPONSES_FROM)};
const CODEX_TO = ${jsString(OPEN_CODE_BROKER_CODEX_RESPONSES_TO)};
const CODEX_ORIGINATOR = ${jsString(OPEN_CODE_BROKER_CODEX_ORIGINATOR)};
const CODEX_OPENAI_BETA = ${jsString(OPEN_CODE_BROKER_CODEX_OPENAI_BETA)};

const ANTHROPIC_BETA = ${jsString(OPEN_CODE_BROKER_ANTHROPIC_BETA)};
const ANTHROPIC_SYSTEM_IDENTITY = ${jsString(OPEN_CODE_BROKER_ANTHROPIC_SYSTEM_IDENTITY)};

${sharedPayload}

// Read the outgoing body as text without consuming the live Request.
async function readRequestBodyText(request) {
  try { return await request.clone().text(); } catch { return null; }
}

function buildReplacementRequest(original, url, headers, bodyText) {
  return new Request(url, {
    method: original.method,
    headers: headers,
    body: bodyText === null || bodyText === undefined ? undefined : bodyText,
    signal: original.signal,
    redirect: original.redirect,
  });
}

async function shapeCodexHttpRequest(original) {
  const token = await getAccessToken(false);
  const bodyText = await readRequestBodyText(original);
  // Reuse the single Codex body policy (model normalize, store=false, include).
  const fakeInit = bodyText === null ? null : { body: bodyText };
  const transformed = transformCodexBody(fakeInit);
  const finalBody = transformed.init && typeof transformed.init.body === "string" ? transformed.init.body : bodyText;
  const headers = buildCodexHeaders(
    { headers: original.headers, __promptCacheKey: transformed.promptCacheKey },
    token.accountId,
    token.accessToken,
  );
  return { request: buildReplacementRequest(original, rewriteCodexUrl(original.url), headers, finalBody), token: token };
}

async function shapeAnthropicHttpRequest(original) {
  const token = await getAccessToken(false);
  const bodyText = await readRequestBodyText(original);
  const withIdentity = bodyText === null ? { headers: original.headers } : injectAnthropicSystemIdentity({ headers: original.headers, body: bodyText });
  const finalBody = withIdentity && typeof withIdentity.body === "string" ? withIdentity.body : bodyText;
  const headers = buildAnthropicHeaders({ headers: original.headers }, token.accessToken);
  return { request: buildReplacementRequest(original, original.url, headers, finalBody), token: token };
}

async function shapeHttpRequest(original) {
  if (PROVIDER === "openai") return shapeCodexHttpRequest(original);
  return shapeAnthropicHttpRequest(original);
}

async function retryHttpResponseWithFreshToken(originalRequest) {
  const fresh = await getAccessToken(true);
  const bodyText = await readRequestBodyText(originalRequest);
  let headers;
  let url = originalRequest.url;
  let finalBody = bodyText;
  if (PROVIDER === "openai") {
    const fakeInit = bodyText === null ? null : { body: bodyText };
    const transformed = transformCodexBody(fakeInit);
    finalBody = transformed.init && typeof transformed.init.body === "string" ? transformed.init.body : bodyText;
    headers = buildCodexHeaders(
      { headers: originalRequest.headers, __promptCacheKey: transformed.promptCacheKey },
      fresh.accountId,
      fresh.accessToken,
    );
    url = rewriteCodexUrl(originalRequest.url);
  } else {
    const withIdentity = bodyText === null ? { headers: originalRequest.headers } : injectAnthropicSystemIdentity({ headers: originalRequest.headers, body: bodyText });
    finalBody = withIdentity && typeof withIdentity.body === "string" ? withIdentity.body : bodyText;
    headers = buildAnthropicHeaders({ headers: originalRequest.headers }, fresh.accessToken);
  }
  const retried = await fetch(buildReplacementRequest(originalRequest, url, headers, finalBody));
  return retried;
}

export default {
  id: "happier-broker-" + PROVIDER,
  setup: async (ctx) => {
    void sendLoadHandshake();
    await ctx.session.hook("model.request", async (evt) => {
      if (PROVIDER === "openai") evt.baseURL = CODEX_BASE_URL;
    }, { providerID: PROVIDER });
    await ctx.session.hook("http.request", async (evt) => {
      const shaped = await shapeHttpRequest(evt.request);
      evt.request = shaped.request;
    }, { providerID: PROVIDER });
    await ctx.session.hook("http.response", async (evt) => {
      if (!evt.response || evt.response.status !== 401) return;
      try { await evt.response.body?.cancel().catch(() => undefined); } catch {}
      evt.response = await retryHttpResponseWithFreshToken(evt.request);
    }, { providerID: PROVIDER });
  },
};
`;
}
