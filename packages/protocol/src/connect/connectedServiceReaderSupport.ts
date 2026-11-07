import type { AccountProfile } from '../account/profile.js';
import type { SessionRuntimeIssueV1 } from '../sessions/control/runtimeIssueV1.js';
import { ConnectedServiceIdSchema, type ConnectedServiceId } from './connectedServiceBindings.js';

export const CONNECTED_SERVICE_READER_SUPPORT_QUERY_KEY = 'happierConnectedServices';
export const CONNECTED_SERVICE_READER_SUPPORT_SOCKET_AUTH_FIELD = 'connectedServiceIds';

export const RELEASED_CONNECTED_SERVICE_IDS: readonly ConnectedServiceId[] = [
  'openai-codex', 'openai', 'anthropic', 'claude-subscription', 'gemini', 'github',
];

// UI/server v0.2.16 and CLI v0.2.15 (22ac8263) use this closed six-service enum;
// the retained UI/server v0.2.15 reader fixtures have equivalent constraints.
// Remove outward degradation when those readers retire; never rewrite stored identity.
export function readConnectedServiceReaderSupport(raw: unknown): readonly ConnectedServiceId[] {
  let decoded: unknown = raw;
  if (typeof raw === 'string') {
    try { decoded = JSON.parse(raw); } catch { return RELEASED_CONNECTED_SERVICE_IDS; }
  }
  if (!Array.isArray(decoded) || !decoded.every(value => typeof value === 'string')) return RELEASED_CONNECTED_SERVICE_IDS;
  return ConnectedServiceIdSchema.options.filter(serviceId => RELEASED_CONNECTED_SERVICE_IDS.includes(serviceId) || decoded.includes(serviceId));
}

type ServiceProfileProjection = Partial<Pick<AccountProfile, 'connectedServicesV2' | 'connectedServiceCredentialRevisionsV1'>>;
export function projectConnectedServiceProfileForReader<T extends ServiceProfileProjection>(value: T, supportedIds: readonly ConnectedServiceId[]): T {
  const connectedServicesV2 = value.connectedServicesV2?.filter(entry => supportedIds.includes(entry.serviceId));
  const connectedServiceCredentialRevisionsV1 = value.connectedServiceCredentialRevisionsV1?.filter(entry => supportedIds.includes(entry.serviceId));
  if (connectedServicesV2?.length === value.connectedServicesV2?.length && connectedServiceCredentialRevisionsV1?.length === value.connectedServiceCredentialRevisionsV1?.length) return value;
  return { ...value, ...(connectedServicesV2 ? { connectedServicesV2 } : {}), ...(connectedServiceCredentialRevisionsV1 ? { connectedServiceCredentialRevisionsV1 } : {}) };
}

export function projectSessionRuntimeIssueForReader<T extends SessionRuntimeIssueV1 | null | undefined>(issue: T, supportedIds: readonly ConnectedServiceId[]): T {
  if (!issue?.usageLimit) return issue;
  const { connectedService, quotaSnapshotRef, ...genericUsageLimit } = issue.usageLimit;
  const supportsConnectedService = !connectedService || supportedIds.includes(connectedService.serviceId);
  const supportsQuotaSnapshot = !quotaSnapshotRef || supportedIds.includes(quotaSnapshotRef.serviceId);
  if (supportsConnectedService && supportsQuotaSnapshot) return issue;
  return { ...issue, usageLimit: { ...genericUsageLimit,
    ...(supportsConnectedService && connectedService !== undefined ? { connectedService } : {}),
    ...(supportsQuotaSnapshot && quotaSnapshotRef !== undefined ? { quotaSnapshotRef } : {}),
  } };
}

export function supportsConnectedServiceOperation(payload: unknown, serviceId: ConnectedServiceId): boolean {
  if (RELEASED_CONNECTED_SERVICE_IDS.includes(serviceId)) return true;
  if (!payload || typeof payload !== 'object' || !('capabilities' in payload)) return false;
  const capabilities = payload.capabilities;
  if (!capabilities || typeof capabilities !== 'object' || !('connectedServices' in capabilities)) return false;
  const connectedServices = capabilities.connectedServices;
  if (!connectedServices || typeof connectedServices !== 'object' || !('supportedServiceIds' in connectedServices)) return false;
  const supportedServiceIds = connectedServices.supportedServiceIds;
  // Feature payloads use a typed array. JSON text is accepted only at the
  // HTTP query transport boundary, never as a server admission declaration.
  if (!Array.isArray(supportedServiceIds) || !supportedServiceIds.every(value => typeof value === 'string')) return false;
  return readConnectedServiceReaderSupport(supportedServiceIds).includes(serviceId);
}

export function withConnectedServiceReaderSupport(url: string): string {
  const hashAt = url.indexOf('#');
  const path = hashAt < 0 ? url : url.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : url.slice(hashAt);
  const queryAt = path.indexOf('?');
  const pathname = queryAt < 0 ? path : path.slice(0, queryAt);
  const query = new URLSearchParams(queryAt < 0 ? '' : path.slice(queryAt + 1));
  query.set(CONNECTED_SERVICE_READER_SUPPORT_QUERY_KEY, JSON.stringify(ConnectedServiceIdSchema.options));
  return `${pathname}?${query.toString()}${hash}`;
}
