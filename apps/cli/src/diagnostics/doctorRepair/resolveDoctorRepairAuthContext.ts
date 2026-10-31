import { resolveMachineIdForServerFromSettings } from '@/daemon/resolveMachineIdForServerFromSettings';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { resolveServerProfileApiUrl } from '@/server/serverProfileApiUrl';
import { normalizeServerHttpBaseUrl, resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { readCredentials, readSettings } from '@/persistence';
import type { AuthSignalsForProfile } from './classifyAuth';
import { checkAuthLive } from './authLiveCheck';

/**
 * Assemble auth signals from the requested profile's credential store, or the
 * runtime profile for an unscoped report. Known accounts select only their
 * matching machine identity; other profiles expose historical metadata.
 *
 * Live-check policy: when a non-empty token exists we make a single
 * `GET /v1/account/profile` call for the inspected profile only, with a 3s
 * timeout. A 401/403 flips `isExpired` to true; anything else leaves it
 * false so the `auth_expired_for_active_profile` finding doesn't false-fire
 * offline. Unrequested profiles don't get a live check — their `isExpired`
 * remains unknown (false) here; expiry on those is surfaced lazily when
 * the user actually switches to them.
 */
export async function resolveDoctorRepairAuthContext(params: Readonly<{
  /**
   * When set, the auth signals are built as if this profile were active —
   * driving live-check, expiry, and `isActive` flags off it instead of
   * the runtime selection. Surfaces absence: when no profile matches,
   * `targetProfileExists` is `false`.
   */
  targetServerId: string | null;
} > = { targetServerId: null }): Promise<Readonly<{
  activeServerUrl: string | null;
  authSignals: readonly AuthSignalsForProfile[];
  hasAnyServerProfile: boolean;
  /**
   * `null` when no `targetServerId` was passed (unscoped report).
   * `true` when the requested server profile exists in settings.
   * `false` when the requested server profile is not configured — the
   * caller emits `server_profile_missing` in this case.
   */
  targetProfileExists: boolean | null;
}>> {
  const [settings, credentials] = await Promise.all([
    readSettings().catch(() => null),
    readCredentials(params.targetServerId === null ? {} : { serverId: params.targetServerId }).catch(() => null),
  ]);
  const servers = settings?.servers ?? {};
  const runtimeServerId = configuration.activeServerId;
  const machineIdByServerId = settings?.machineIdByServerId ?? {};
  const lastTokenSubByServerId = settings?.lastTokenSubByServerId ?? {};
  const profiles = Object.values(servers).filter((p): p is NonNullable<typeof p> => Boolean(p));
  // Runtime selection is authoritative even when an env-selected profile is not saved yet.
  if (!profiles.some((profile) => profile.id === runtimeServerId)) {
    profiles.push({ id: runtimeServerId, name: runtimeServerId, serverUrl: configuration.serverUrl,
      webappUrl: configuration.webappUrl, createdAt: 0, updatedAt: 0, lastUsedAt: 0 });
  }
  const hasAnyServerProfile = profiles.length > 0;

  // When `--server <id>` is set, the report treats THAT profile as active
  // for the purpose of finding generation. Settings aren't mutated; only
  // the in-memory snapshot used to build this report.
  const effectiveActiveServerId = params.targetServerId ?? runtimeServerId;
  const activeProfile = profiles.find((p) => p.id === effectiveActiveServerId) ?? null;
  const targetProfileExists = params.targetServerId === null
    ? null
    : activeProfile !== null;
  const activeServerUrl = activeProfile?.id === runtimeServerId ? configuration.serverUrl : activeProfile?.serverUrl ?? null;

  // Inspect only the requested store, or the runtime store for an unscoped report.
  // Other profiles remain historical metadata; credentials never cross scopes.
  // Reachability tells the renderer whether we actually
  // confirmed the auth state — critical when the relay is down, so users
  // don't see a misleading "signed in" when we couldn't verify.
  const activeToken = String(credentials?.token ?? '').trim();
  const subject = decodeJwtPayload(activeToken)?.sub;
  const accountId = typeof subject === 'string' ? subject.trim() : '';
  let activeExpired = false;
  let activeReachability: 'verified' | 'unreachable' | 'not-probed' = 'not-probed';
  if (activeProfile && activeToken) {
    const result = await checkAuthLive({
      serverUrl: activeProfile.id === runtimeServerId
        ? resolveServerHttpBaseUrl()
        : normalizeServerHttpBaseUrl(resolveServerProfileApiUrl(activeProfile)),
      token: activeToken,
    });
    activeExpired = result.state === 'invalid';
    // Valid and rejected credentials are both definitive answers from the server.
    // 'unknown' means no definitive auth result, including an unexpected response.
    activeReachability = result.state === 'unknown' ? 'unreachable' : 'verified';
  }

  const inspectedMachineId = activeProfile && accountId && settings
    ? resolveMachineIdForServerFromSettings(settings, activeProfile.id, accountId)
    : activeProfile?.id === runtimeServerId ? settings?.machineId : activeProfile ? machineIdByServerId[activeProfile.id] : null;

  const signals: AuthSignalsForProfile[] = profiles.map((profile) => {
    // Unrequested profiles expose only historical metadata; endpoint aliases
    // do not share credentials.
    const lastSub = String(lastTokenSubByServerId[profile.id] ?? '').trim();
    const isActive = profile.id === effectiveActiveServerId;
    const machineId = String(isActive ? inspectedMachineId ?? '' : machineIdByServerId[profile.id] ?? '').trim();
    const isRuntimeProfile = profile.id === runtimeServerId;
    const hasCredentials = isActive ? activeToken.length > 0 : lastSub.length > 0;
    return {
      serverId: profile.id,
      serverName: profile.name || profile.id,
      serverUrl: isRuntimeProfile ? configuration.serverUrl : profile.serverUrl,
      hasCredentials,
      isExpired: isActive ? activeExpired : false,
      machineRegistered: machineId.length > 0,
      credentialEvidence: isActive ? 'inspected-store' : 'historical-record',
      isActive,
      reachability: isActive ? activeReachability : 'not-probed',
    };
  });

  return { activeServerUrl, authSignals: signals, hasAnyServerProfile, targetProfileExists };
}
