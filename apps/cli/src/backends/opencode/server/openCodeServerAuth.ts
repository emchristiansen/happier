/**
 * OpenCode HTTP server authentication encoding.
 *
 * Released OpenCode 2 (`packages/server/src/{auth,process}.ts`, 2.0.15 @ 6f3639d) protects every
 * password-carrying server with Basic auth and pins the username to `opencode` server-side. The
 * password is read from the environment with `OPENCODE_PASSWORD` preferred over the legacy
 * `OPENCODE_SERVER_PASSWORD` (`packages/cli/src/env.ts`), so this module mirrors that precedence.
 *
 * This module owns credential SHAPE and header encoding only. The managed-server credential
 * lifecycle (mint/retain/inject) lives in `openCodeManagedServerCredential.ts`.
 */

/** Basic username accepted by an OpenCode server (fixed server-side in OpenCode 2). */
export const OPEN_CODE_SERVER_BASIC_USERNAME = 'opencode';

/** Canonical OpenCode 2 server password env var. */
export const OPEN_CODE_SERVER_PASSWORD_ENV = 'OPENCODE_PASSWORD';

/** Legacy OpenCode server password env var, still accepted by released OpenCode 2. */
export const OPEN_CODE_SERVER_LEGACY_PASSWORD_ENV = 'OPENCODE_SERVER_PASSWORD';

export type OpenCodeServerAuthCredential = Readonly<{
  username: string;
  password: string;
}>;

function readEnvString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Username for an env-configured credential. The override exists for explicitly externally managed
 * endpoints (e.g. a reverse proxy in front of OpenCode); an OpenCode server itself only ever accepts
 * `opencode`.
 */
function resolveEnvUsername(env: NodeJS.ProcessEnv): string {
  const override = readEnvString(env.OPENCODE_SERVER_USERNAME).trim();
  return override.length > 0 ? override : OPEN_CODE_SERVER_BASIC_USERNAME;
}

/**
 * Credential explicitly configured in the environment, or `null` when no password is configured.
 * `OPENCODE_PASSWORD` wins over the legacy variable, matching the server's own resolution.
 */
export function resolveOpenCodeServerAuthCredentialFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OpenCodeServerAuthCredential | null {
  const password = readEnvString(env[OPEN_CODE_SERVER_PASSWORD_ENV])
    || readEnvString(env[OPEN_CODE_SERVER_LEGACY_PASSWORD_ENV]);
  if (!password) return null;
  return { username: resolveEnvUsername(env), password };
}

export function buildOpenCodeServerBasicAuthHeader(credential: OpenCodeServerAuthCredential): string {
  const token = Buffer.from(`${credential.username}:${credential.password}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

export function resolveOpenCodeServerAuthHeaders(
  credential: OpenCodeServerAuthCredential | null,
): Record<string, string> {
  return credential ? { Authorization: buildOpenCodeServerBasicAuthHeader(credential) } : {};
}

export function resolveOpenCodeServerBasicAuthHeaderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const credential = resolveOpenCodeServerAuthCredentialFromEnv(env);
  return credential ? buildOpenCodeServerBasicAuthHeader(credential) : null;
}

export function resolveOpenCodeServerAuthHeadersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return resolveOpenCodeServerAuthHeaders(resolveOpenCodeServerAuthCredentialFromEnv(env));
}
