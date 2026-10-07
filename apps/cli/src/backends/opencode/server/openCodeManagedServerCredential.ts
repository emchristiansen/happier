import { randomBytes } from 'node:crypto';

import {
  OPEN_CODE_SERVER_BASIC_USERNAME,
  OPEN_CODE_SERVER_LEGACY_PASSWORD_ENV,
  OPEN_CODE_SERVER_PASSWORD_ENV,
  buildOpenCodeServerBasicAuthHeader,
  resolveOpenCodeServerAuthCredentialFromEnv,
  type OpenCodeServerAuthCredential,
} from './openCodeServerAuth';

/**
 * Managed-server credential.
 *
 * Released OpenCode 2 password-protects EVERY `opencode serve`: it uses the password supplied in the
 * environment, otherwise it generates a random secret Happier can never learn (2.0.15
 * `packages/cli/src/server-process.ts`). A managed server started without a supplied password is
 * therefore unusable — readiness, reuse probes and every session request answer 401.
 *
 * Happier mints the password for each managed launch, hands it to the child, and retains it in the
 * canonical managed-server state file written under the existing managed-server lock, bound to that
 * server's `baseUrl`. Any later reader (a reuse probe, a restarted daemon, an attaching terminal)
 * authenticates with the credential of the exact server it is talking to; nothing is derived from a
 * separate machine-global secret and nothing is minted on a read path.
 *
 * Operator-configured passwords are authoritative and are never copied into state. When both variables
 * exist, the child inherits both: retained V1 uses `OPENCODE_SERVER_PASSWORD` plus its username override,
 * while V2 uses canonical-first `OPENCODE_PASSWORD` with the fixed `opencode` username.
 */

/** The state fields this module needs; kept structural so the state owner stays the only importer. */
export type OpenCodeManagedServerAuthState = Readonly<{
  baseUrl: string;
  authPassword?: string;
  apiGeneration?: 'auto' | 'v2';
}>;

export function mintOpenCodeManagedServerPassword(): string {
  return randomBytes(32).toString('base64url');
}

export type OpenCodeManagedServerLaunchCredential = Readonly<{
  credential: OpenCodeServerAuthCredential;
  /**
   * Password to retain in the managed-server state, or `null` when there is nothing to retain: an
   * operator-configured credential is re-derived from the environment (with the managed-server
   * username rule applied), so only a Happier-minted password has to be written down.
   */
  retainedPassword: string | null;
}>;

/** Resolve environment auth for an already detected Happier-managed server generation. */
function resolveManagedEnvironmentCredential(
  env: NodeJS.ProcessEnv,
  apiGeneration: 'auto' | 'v2' = 'auto',
): OpenCodeServerAuthCredential | null {
  const configured = apiGeneration === 'v2'
    ? resolveOpenCodeServerAuthCredentialFromEnv(env)
    : resolveOpenCodeServerAuthCredentialFromEnv({
        ...env,
        [OPEN_CODE_SERVER_PASSWORD_ENV]: '',
      });
  if (!configured) return null;
  return apiGeneration === 'v2'
    ? { username: OPEN_CODE_SERVER_BASIC_USERNAME, password: configured.password }
    : configured;
}

/** Project a launch credential onto released OpenCode 2's fixed Basic-auth username. */
export function resolveOpenCodeManagedServerV2Credential(
  credential: OpenCodeServerAuthCredential,
): OpenCodeServerAuthCredential {
  return { username: OPEN_CODE_SERVER_BASIC_USERNAME, password: credential.password };
}

export function resolveOpenCodeManagedServerReadinessCredentials(params: Readonly<{
  env: NodeJS.ProcessEnv;
  launchCredential: OpenCodeServerAuthCredential;
}>): Readonly<{
  v1: OpenCodeServerAuthCredential | null;
  v2: OpenCodeServerAuthCredential;
}> {
  const legacyPassword = typeof params.env[OPEN_CODE_SERVER_LEGACY_PASSWORD_ENV] === 'string'
    ? params.env[OPEN_CODE_SERVER_LEGACY_PASSWORD_ENV]
    : '';
  const v1 = legacyPassword
    ? resolveManagedEnvironmentCredential(params.env, 'auto')
    : null;
  return {
    v1,
    v2: resolveOpenCodeManagedServerV2Credential(params.launchCredential),
  };
}

/**
 * Credential for a managed server ABOUT TO BE LAUNCHED. The minted username is the server-fixed
 * `opencode`. A canonical OpenCode 2 password also pins that username because released OpenCode 2
 * ignores `OPENCODE_SERVER_USERNAME`; a legacy-only configured credential keeps the override for the
 * retained V1 line. External endpoints resolve their ambient credential through `openCodeServerAuth`
 * and are therefore unaffected by this managed-child rule.
 */
export function resolveOpenCodeManagedServerLaunchCredential(
  env: NodeJS.ProcessEnv = process.env,
): OpenCodeManagedServerLaunchCredential {
  const configured = resolveOpenCodeServerAuthCredentialFromEnv(env);
  if (configured) {
    return {
      credential: env[OPEN_CODE_SERVER_PASSWORD_ENV]
        ? resolveOpenCodeManagedServerV2Credential(configured)
        : configured,
      retainedPassword: null,
    };
  }
  const password = mintOpenCodeManagedServerPassword();
  return {
    credential: { username: OPEN_CODE_SERVER_BASIC_USERNAME, password },
    retainedPassword: password,
  };
}

/**
 * Credential for an ALREADY RUNNING managed server, from its retained state. The retained password is
 * only used for the exact `baseUrl` it was recorded for, so a stale state file can never send one
 * server's credential to another. Falls back to the operator-configured environment credential, which
 * is what a legacy state file (written before the password was retained) was started with.
 */
export function resolveOpenCodeManagedServerStateCredential(params: Readonly<{
  state: OpenCodeManagedServerAuthState | null;
  baseUrl?: string | null;
  env?: NodeJS.ProcessEnv;
}>): OpenCodeServerAuthCredential | null {
  const env = params.env ?? process.env;
  const state = params.state;
  const requestedBaseUrl = typeof params.baseUrl === 'string' ? params.baseUrl.trim() : '';
  const matchesRequestedServer = !requestedBaseUrl || isOpenCodeManagedServerStateTarget({ state, baseUrl: requestedBaseUrl });
  if (!matchesRequestedServer) return null;
  const password = typeof state?.authPassword === 'string' ? state.authPassword : '';
  if (password && matchesRequestedServer) {
    return { username: OPEN_CODE_SERVER_BASIC_USERNAME, password };
  }
  // Missing generation is a predecessor state shape whose resolver used the `auto`/retained-V1
  // contract. Newly detected V2 states are written explicitly as `v2`.
  return resolveManagedEnvironmentCredential(env, state?.apiGeneration ?? 'auto');
}

function normalizeManagedBaseUrl(rawBaseUrl: string): string {
  return rawBaseUrl.trim().replace(/\/+$/u, '');
}

export function isOpenCodeManagedServerStateTarget(params: Readonly<{
  state: OpenCodeManagedServerAuthState | null;
  baseUrl: string;
}>): boolean {
  const stateBaseUrl = normalizeManagedBaseUrl(params.state?.baseUrl ?? '');
  const requestedBaseUrl = normalizeManagedBaseUrl(params.baseUrl);
  return stateBaseUrl.length > 0 && requestedBaseUrl.length > 0 && stateBaseUrl === requestedBaseUrl;
}

/**
 * Password env projection for the managed child process. Only the canonical OpenCode 2 variable is
 * written: the retained OpenCode 1 line does not know it, so a stable-generation managed server keeps
 * serving exactly as before instead of being locked behind a legacy credential contract Happier cannot
 * verify. An operator-configured legacy password is already in the inherited environment.
 */
export function resolveOpenCodeManagedServerCredentialChildEnv(
  credential: OpenCodeServerAuthCredential,
): Readonly<Record<string, string>> {
  return { [OPEN_CODE_SERVER_PASSWORD_ENV]: credential.password };
}

/**
 * Refresh an OpenCode client's live header object from the current managed-server state.
 *
 * The header object is mutated in place on purpose: it is shared by every request the client issues,
 * so a managed-server replacement (new process, new password) must be picked up without rebuilding
 * dozens of request call sites. Passing a non-managed state (or none) restores the environment
 * credential, which is what explicit/external endpoints use.
 */
export function applyOpenCodeManagedServerAuthHeaders(
  headers: Record<string, string>,
  params: Readonly<{
    state: OpenCodeManagedServerAuthState | null;
    baseUrl?: string | null;
    env?: NodeJS.ProcessEnv;
  }>,
): void {
  const requestedBaseUrl = typeof params.baseUrl === 'string' ? params.baseUrl.trim() : '';
  const targetsManagedState = !requestedBaseUrl
    || isOpenCodeManagedServerStateTarget({ state: params.state, baseUrl: requestedBaseUrl });
  const credential = targetsManagedState
    ? resolveOpenCodeManagedServerStateCredential(params)
    : resolveOpenCodeServerAuthCredentialFromEnv(params.env ?? process.env);
  if (!credential) {
    delete headers.Authorization;
    return;
  }
  headers.Authorization = buildOpenCodeServerBasicAuthHeader(credential);
}
