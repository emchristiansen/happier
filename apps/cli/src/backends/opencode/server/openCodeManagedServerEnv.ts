import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { normalizeOpenCodeCliGeneration } from '@happier-dev/agents';

import { isOpenCodeBrokerMarker } from '@/backends/opencode/brokerPlugin/openCodeBrokerPluginEnv';

import { resolveOpenCodeManagedServerCredentialChildEnv } from './openCodeManagedServerCredential';
import {
  OPEN_CODE_SERVER_LEGACY_PASSWORD_ENV,
  OPEN_CODE_SERVER_PASSWORD_ENV,
  type OpenCodeServerAuthCredential,
} from './openCodeServerAuth';

/**
 * Env var carrying the STABLE connected-service selection identity for the managed server launch
 * fingerprint. Populated by the connected-services materializer (Lane B1) alongside
 * `OPENCODE_AUTH_CONTENT`. It must encode the account/profile selection (NOT rotating token bytes)
 * so that a token refresh for the same account does not change the fingerprint (and therefore does
 * not churn the managed server). See `resolveOpenCodeManagedServerLaunchFingerprint`.
 */
export const OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV = 'HAPPIER_OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY';

/**
 * Optional env var carrying an explicit opencode binary identity (e.g. `version|path`) for the
 * launch fingerprint. When unset, the fingerprint folds in `HAPPIER_OPENCODE_PATH` (an explicit
 * binary override) so changing the binary path yields a new fingerprint.
 */
export const OPENCODE_BINARY_IDENTITY_ENV = 'HAPPIER_OPENCODE_BINARY_IDENTITY';

/** The existing launch identity is a SHA-256 hex digest, never a filesystem path. */
export function isOpenCodeManagedServerLaunchFingerprint(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function hashEnvSecret(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  if (!raw) return '';
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Hash of the NON-BROKER (direct API key) auth content (F3). Direct API keys (OpenAI platform key,
 * Anthropic Console key) are REAL secrets carried in `OPENCODE_AUTH_CONTENT`, so a direct-key rotation
 * under the same selection identity must re-key the managed server (otherwise the stale server keeps
 * using the old key). We hash ONLY entries whose `key` is NOT a stable Happier broker marker, so:
 *  - a direct-key change ⇒ changed hash ⇒ new fingerprint (server re-keyed), while
 *  - a brokered OAuth rotation leaves the constant marker bytes unchanged ⇒ unchanged hash ⇒ NO churn.
 *
 * Parse failures and missing content yield an empty hash (native sessions have no auth content).
 */
function hashDirectKeyAuthContent(rawAuthContent: unknown): string {
  const raw = typeof rawAuthContent === 'string' ? rawAuthContent.trim() : '';
  if (!raw) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Unparseable content: fold the whole blob so a malformed-but-distinct credential never collides.
    return createHash('sha256').update(raw).digest('hex');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
  const directEntries: Record<string, unknown> = {};
  for (const [provider, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const { type, key } = entry as { type?: unknown; key?: unknown };
    // Fold ONLY real direct API keys: `{type:'api', key}` where `key` is NOT a stable broker marker.
    // Brokered providers materialize a `type:'api'` BROKER MARKER (constant ⇒ excluded ⇒ no churn);
    // any non-`api` entry (e.g. a legacy `type:'oauth'`) is governed by the selection identity, not by
    // its rotating bytes, so it is excluded here to avoid reintroducing rotation churn.
    if (type !== 'api') continue;
    if (isOpenCodeBrokerMarker(key)) continue;
    directEntries[provider] = entry;
  }
  const providers = Object.keys(directEntries);
  if (providers.length === 0) return '';
  // Stable, order-independent serialization of the direct entries.
  const canonical = providers.sort().map((provider) => [provider, directEntries[provider]] as const);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function normalizeIdentityValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveOpenCodeManagedServerChildEnv(params: Readonly<{
  baseEnv: NodeJS.ProcessEnv;
  xdgRootDir: string | null;
  isolateConfig: boolean;
  /**
   * Credential the managed server must protect itself with. Supplied only by the spawn path: the
   * launch fingerprint intentionally computes the child env WITHOUT it, because the Happier-minted
   * password is machine-stable and folding it in would re-key every managed server once, for no
   * reuse-relevant difference. Operator-configured passwords are folded in from `baseEnv` instead.
   */
  authCredential?: OpenCodeServerAuthCredential | null;
}>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...params.baseEnv,
    // Ensure the subprocess has a stable, explicit config envelope.
    OPENCODE_CONFIG_CONTENT: params.baseEnv.OPENCODE_CONFIG_CONTENT ?? '{}',
    ...(params.authCredential
      ? resolveOpenCodeManagedServerCredentialChildEnv(params.authCredential)
      : {}),
  };

  const xdgRootDir = typeof params.xdgRootDir === 'string' ? params.xdgRootDir.trim() : '';
  if (!xdgRootDir) return env;

  env.XDG_DATA_HOME = join(xdgRootDir, 'data');
  env.XDG_STATE_HOME = join(xdgRootDir, 'state');
  env.XDG_CACHE_HOME = join(xdgRootDir, 'cache');
  if (params.isolateConfig) {
    env.XDG_CONFIG_HOME = join(xdgRootDir, 'config');
  }
  return env;
}

/**
 * Compute the managed-server launch fingerprint: the value that determines whether a connected (or
 * native) session may REUSE an existing managed `opencode serve` process.
 *
 * The fingerprint keys on a STABLE selection identity (provider/connected-mode/account/profile +
 * broker plugin + config isolation + XDG root + binary + server auth) and EXCLUDES rotating
 * access/refresh token values. Inputs:
 * - `connectedServiceSelectionIdentity` (or `OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV` in
 *   `baseEnv`): the stable per-account identity emitted by the materializer. When present it
 *   REPLACES the rotating auth-content hash, so a same-account token rotation keeps the fingerprint
 *   unchanged.
 * - When NO selection identity is present (native sessions, or the pre-broker transition), the
 *   fingerprint falls back to hashing `OPENCODE_AUTH_CONTENT` so distinct stored credentials never
 *   collide. Native sessions have no `OPENCODE_AUTH_CONTENT`, so their auth-identity class is empty
 *   and never collides with connected sessions.
 * - `openCodeBinaryIdentity` (or `OPENCODE_BINARY_IDENTITY_ENV`, else `HAPPIER_OPENCODE_PATH`):
 *   changing the opencode binary yields a new fingerprint.
 * - `HAPPIER_OPENCODE_CLI_GENERATION`: Stable and V2 are distinct process contracts even when
 *   both resolve to the released `opencode` executable name.
 *
 * NOTE: the runtime "generation key" (see `openCodeManagedServerIdentity.ts`, which changes on every
 * process start) is intentionally NOT part of this fingerprint — that would defeat server reuse.
 * The fingerprint governs REUSE; the generation key tracks process IDENTITY across reuse.
 */
export function resolveOpenCodeManagedServerLaunchFingerprint(params: Readonly<{
  baseEnv: NodeJS.ProcessEnv;
  xdgRootDir: string | null;
  isolateConfig: boolean;
  connectedServiceSelectionIdentity?: string | null;
  openCodeBinaryIdentity?: string | null;
}>): string {
  const env = resolveOpenCodeManagedServerChildEnv({
    baseEnv: params.baseEnv,
    xdgRootDir: params.xdgRootDir,
    isolateConfig: params.isolateConfig,
  });

  const selectionIdentity = normalizeIdentityValue(
    params.connectedServiceSelectionIdentity
    ?? env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV],
  );
  // Stable selection identity wins; otherwise fall back to the (rotating) auth-content hash so two
  // different stored credentials never collide. Native => no auth content => empty class.
  const authContentHash = hashEnvSecret(env.OPENCODE_AUTH_CONTENT);
  const authIdentityClass = selectionIdentity
    ? `selection:${selectionIdentity}`
    : authContentHash
      ? `auth-content:${authContentHash}`
      : '';

  // F3: even when keyed on the stable selection identity, fold a hash of the NON-broker (direct API
  // key) auth content so a direct-key rotation re-keys the server. Brokered OAuth markers are constant
  // ⇒ excluded ⇒ no churn for brokered rotation. Empty for native + broker-only sessions.
  const directKeyAuthHash = hashDirectKeyAuthContent(env.OPENCODE_AUTH_CONTENT);

  const openCodeBinaryIdentity = normalizeIdentityValue(
    params.openCodeBinaryIdentity
    ?? env[OPENCODE_BINARY_IDENTITY_ENV]
    ?? env.HAPPIER_OPENCODE_PATH,
  );
  const requestedCliGeneration = normalizeOpenCodeCliGeneration(env.HAPPIER_OPENCODE_CLI_GENERATION);

  const relevant = {
    HOME: typeof env.HOME === 'string' ? env.HOME : '',
    USERPROFILE: typeof env.USERPROFILE === 'string' ? env.USERPROFILE : '',
    HAPPIER_HOME_DIR: typeof env.HAPPIER_HOME_DIR === 'string' ? env.HAPPIER_HOME_DIR : '',
    XDG_CONFIG_HOME: typeof env.XDG_CONFIG_HOME === 'string' ? env.XDG_CONFIG_HOME : '',
    XDG_DATA_HOME: typeof env.XDG_DATA_HOME === 'string' ? env.XDG_DATA_HOME : '',
    XDG_STATE_HOME: typeof env.XDG_STATE_HOME === 'string' ? env.XDG_STATE_HOME : '',
    XDG_CACHE_HOME: typeof env.XDG_CACHE_HOME === 'string' ? env.XDG_CACHE_HOME : '',
    OPENCODE_CONFIG_CONTENT: typeof env.OPENCODE_CONFIG_CONTENT === 'string' ? env.OPENCODE_CONFIG_CONTENT : '',
    authIdentityClass,
    directKeyAuthHash,
    openCodeBinaryIdentity,
    ...(requestedCliGeneration === 'auto' ? {} : { openCodeApiGeneration: requestedCliGeneration }),
    OPENAI_API_KEY: typeof env.OPENAI_API_KEY === 'string' ? env.OPENAI_API_KEY : '',
    ANTHROPIC_API_KEY: typeof env.ANTHROPIC_API_KEY === 'string' ? env.ANTHROPIC_API_KEY : '',
    OPENCODE_SERVER_USERNAME: typeof env.OPENCODE_SERVER_USERNAME === 'string' ? env.OPENCODE_SERVER_USERNAME : '',
    // Operator-configured server credentials are a reuse identity: a server protected by one password
    // cannot serve a session that authenticates with another. Both released names are folded (hashed
    // together with the rest of the envelope), canonical first.
    [OPEN_CODE_SERVER_PASSWORD_ENV]: typeof env[OPEN_CODE_SERVER_PASSWORD_ENV] === 'string'
      ? env[OPEN_CODE_SERVER_PASSWORD_ENV]
      : '',
    [OPEN_CODE_SERVER_LEGACY_PASSWORD_ENV]: typeof env[OPEN_CODE_SERVER_LEGACY_PASSWORD_ENV] === 'string'
      ? env[OPEN_CODE_SERVER_LEGACY_PASSWORD_ENV]
      : '',
  };

  return createHash('sha256').update(JSON.stringify(relevant)).digest('hex');
}
