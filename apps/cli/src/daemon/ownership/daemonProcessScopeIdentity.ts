import { configuration } from '@/configuration';
import type { HappyProcessInfo } from '@/daemon/doctor';
import { resolveHappierHomeDirComparableKey } from './happierHomeDirComparableKey';

function normalizeScopeValue(value: string | null | undefined): string {
  return String(value ?? '').trim();
}

function normalizeServerUrl(value: string | null | undefined): string {
  return normalizeScopeValue(value).replace(/\/+$/, '').toLowerCase();
}

/** Unknown inventory facts can supplement existing ownership evidence, never establish it. */
export function daemonProcessMatchesCurrentScope(
  processInfo: HappyProcessInfo,
  options: Readonly<{ requireScopeIdentity?: boolean }> = {},
): boolean {
  const required = options.requireScopeIdentity === true;
  const env = processInfo.daemonOwnershipEnvironmentVariables;
  if (!env) return !required;
  const home = resolveHappierHomeDirComparableKey(env.HAPPIER_HOME_DIR);
  const currentHome = resolveHappierHomeDirComparableKey(configuration.happyHomeDir);
  if (required && (!home || !currentHome)) return false;
  if (home && currentHome && home !== currentHome) return false;

  const lifecycle = normalizeScopeValue(env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID);
  // A standalone daemon has no explicit lifecycle env, but its children receive the
  // resolved active-server id as their lifecycle identity from the spawn owner.
  const currentLifecycle = normalizeScopeValue(process.env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID)
    || normalizeScopeValue(configuration.activeServerId);
  if (lifecycle) {
    // The explicit lifecycle identity survives endpoint/profile changes.
    return Boolean(currentLifecycle) && lifecycle === currentLifecycle;
  }
  // Released runners may predate explicit lifecycle scope; retain their recorded relay identity.
  const active = normalizeScopeValue(env.HAPPIER_ACTIVE_SERVER_ID);
  const currentActive = currentLifecycle;
  if (required && (!active || !currentActive)) return false;
  if (active && currentActive && active !== currentActive) return false;
  const server = normalizeServerUrl(env.HAPPIER_SERVER_URL);
  if (!server) return !required;
  const currentServers = new Set([
    configuration.serverUrl, configuration.apiServerUrl, configuration.publicServerUrl,
  ].map(normalizeServerUrl).filter(Boolean));
  return currentServers.size === 0 ? !required : currentServers.has(server);
}
