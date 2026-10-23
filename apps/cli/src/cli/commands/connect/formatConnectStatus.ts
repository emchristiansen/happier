import chalk from 'chalk';

import type {
  ConnectedServiceCredentialHealthStatusV1,
  ConnectedServiceCredentialHealthV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';

/** One profile as `GET /v2/connect/:serviceId/profiles` reports it. */
export type ConnectStatusProfile = Readonly<{
  profileId: string;
  status: ConnectedServiceCredentialHealthStatusV1;
  kind?: 'oauth' | 'token' | null;
  providerEmail?: string | null;
  expiresAt?: number | null;
  health?: ConnectedServiceCredentialHealthV1 | null;
  healthUnrecognised?: true;
}>;

/** One service id's profile list, or the fact that it could not be fetched. */
export type ConnectStatusServiceListing =
  | Readonly<{ serviceId: ConnectedServiceId; outcome: 'listed'; profiles: readonly ConnectStatusProfile[] }>
  | Readonly<{ serviceId: ConnectedServiceId; outcome: 'failed' }>;

/** A connect target: not supported, its service ids not resolvable, or its service listings. */
export type ConnectStatusVendor =
  | Readonly<{ vendorDisplayName: string; kind: 'unsupported' }>
  | Readonly<{ vendorDisplayName: string; kind: 'unresolved' }>
  | Readonly<{ vendorDisplayName: string; kind: 'services'; services: readonly ConnectStatusServiceListing[] }>;

const VENDOR_INDENT = '  ';
const PROFILE_INDENT = '      ';
const DETAIL_INDENT = '        ';

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function formatUtc(ms: number): string {
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : `${ms} (not a valid time)`;
}

function formatStatus(status: ConnectedServiceCredentialHealthStatusV1): string {
  if (status === 'connected') return chalk.green(status);
  return chalk.yellow(status);
}

function formatProfileDetails(profile: ConnectStatusProfile): string[] {
  const details: string[] = [];
  if (profile.kind) details.push(`kind: ${profile.kind}`);
  if (profile.providerEmail) details.push(`email: ${profile.providerEmail}`);
  if (typeof profile.expiresAt === 'number') details.push(`expires at: ${formatUtc(profile.expiresAt)}`);
  const health = profile.health;
  if (profile.healthUnrecognised) {
    details.push('health: not shown (the server sent a shape this client does not recognise)');
  }
  if (health) {
    details.push(`health: ${health.status}`);
    details.push(`reconnect required: ${health.reconnectRequired ? 'yes' : 'no'}`);
    if (health.lastRefreshSuccessAt !== undefined) details.push(`last refresh success: ${formatUtc(health.lastRefreshSuccessAt)}`);
    if (health.lastRefreshFailureAt !== undefined) details.push(`last refresh failure: ${formatUtc(health.lastRefreshFailureAt)}`);
    if (health.lastRefreshFailureKind !== undefined) details.push(`last refresh failure kind: ${health.lastRefreshFailureKind}`);
    if (health.providerHttpStatus !== undefined) details.push(`provider http status: ${health.providerHttpStatus}`);
    if (health.providerErrorCode !== undefined) details.push(`provider error code: ${health.providerErrorCode}`);
    if (health.lastRuntimeAuthFailureAt !== undefined) {
      details.push(`last runtime auth failure: ${formatUtc(health.lastRuntimeAuthFailureAt)}`);
    }
  }
  return details.map((detail) => `${DETAIL_INDENT}${chalk.gray(detail)}`);
}

function formatProfile(serviceId: ConnectedServiceId, profile: ConnectStatusProfile): string[] {
  return [
    `${PROFILE_INDENT}${serviceId}/${profile.profileId}: ${formatStatus(profile.status)}`,
    ...formatProfileDetails(profile),
  ];
}

function formatVendor(vendor: ConnectStatusVendor, profileFilter: string | null): string[] {
  const name = vendor.vendorDisplayName;
  if (vendor.kind === 'unsupported') {
    return [`${VENDOR_INDENT}${chalk.gray('○')}  ${name}: ${chalk.gray('not supported')}`];
  }
  if (vendor.kind === 'unresolved' || vendor.services.every((service) => service.outcome === 'failed')) {
    return [`${VENDOR_INDENT}${chalk.yellow('?')}  ${name}: ${chalk.yellow('unknown (check failed)')}`];
  }

  const emptyLabel = profileFilter === null ? 'not connected' : `no profile ${profileFilter}`;
  const services = [...vendor.services]
    .sort((a, b) => compareText(a.serviceId, b.serviceId))
    .map((service) => service.outcome === 'failed'
      ? service
      : {
          ...service,
          profiles: service.profiles
            .filter((profile) => profileFilter === null || profile.profileId === profileFilter)
            .sort((a, b) => compareText(a.profileId, b.profileId)),
        });
  const shownProfiles = services.flatMap((service) => service.outcome === 'listed' ? service.profiles : []);
  const anyFailed = services.some((service) => service.outcome === 'failed');

  if (shownProfiles.length === 0 && !anyFailed) {
    return [`${VENDOR_INDENT}${chalk.gray('○')}  ${name}: ${chalk.gray(emptyLabel)}`];
  }

  const icon = shownProfiles.some((profile) => profile.status === 'connected')
    ? chalk.green('✓')
    : shownProfiles.length > 0
      ? chalk.yellow('⚠️')
      : chalk.yellow('?');
  const lines = [`${VENDOR_INDENT}${icon}  ${name}`];
  for (const service of services) {
    if (service.outcome === 'failed') {
      lines.push(`${PROFILE_INDENT}${service.serviceId}: ${chalk.yellow('unknown (check failed)')}`);
    } else if (service.profiles.length === 0) {
      lines.push(`${PROFILE_INDENT}${service.serviceId}: ${chalk.gray(emptyLabel)}`);
    } else {
      for (const profile of service.profiles) lines.push(...formatProfile(service.serviceId, profile));
    }
  }
  return lines;
}

/**
 * The body of `happier connect status`: one heading per vendor, then every profile of every
 * service id, sorted by service id and profile id. `profileFilter` keeps only profiles with exactly
 * that id. Fields the server did not report are omitted.
 */
export function formatConnectStatusLines(params: Readonly<{
  vendors: readonly ConnectStatusVendor[];
  profileFilter: string | null;
}>): string[] {
  return params.vendors.flatMap((vendor) => formatVendor(vendor, params.profileFilter));
}
