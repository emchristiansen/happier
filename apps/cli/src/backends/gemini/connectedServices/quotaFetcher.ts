import { ConnectedServiceQuotaSnapshotV1Schema, type ConnectedServiceQuotaMeterV1, type ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';
import { ConnectedServiceQuotaFetchError, type ConnectedServiceQuotaFetcher, type ConnectedServiceQuotaFetcherDescriptor } from '@/daemon/connectedServices/quotas/types';
import { requestGoogleCodeAssist, type GoogleCodeAssistFetchRuntime } from '@/daemon/connectedServices/quotas/googleCodeAssistRequest';

function readRecord(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function readString(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function readFiniteNumber(value: unknown): number | null { if (value === null || value === undefined || value === '') return null; const n = typeof value === 'number' ? value : Number(value); return Number.isFinite(n) ? n : null; }
function readResetAtMs(value: unknown): number | null { const text = readString(value); if (!text) return null; const n = Date.parse(text); return Number.isFinite(n) && n >= 0 ? n : null; }
function clampPercent(value: number): number { return Math.max(0, Math.min(100, value)); }
function buildMeter(bucket: unknown): ConnectedServiceQuotaMeterV1 | null {
  const record = readRecord(bucket);
  if (!record) return null;
  const modelId = readString(record.modelId);
  const remainingFraction = readFiniteNumber(record.remainingFraction);
  if (!modelId || remainingFraction === null) return null;

  const remainingAmount = readFiniteNumber(record.remainingAmount);
  const normalizedLimit = 100;
  const limit = remainingAmount !== null && remainingFraction > 0
    ? Math.round(remainingAmount / remainingFraction)
    : normalizedLimit;
  const remaining = remainingAmount !== null
    ? Math.max(0, Math.min(limit, remainingAmount))
    : Math.round(clampPercent(remainingFraction * normalizedLimit));
  const used = Math.max(0, limit - remaining);
  const utilizationPct = clampPercent((1 - remainingFraction) * 100);

  return {
    meterId: modelId,
    label: modelId,
    used,
    limit,
    unit: remainingAmount !== null ? 'count' : 'unknown',
    utilizationPct,
    resetsAt: readResetAtMs(record.resetTime),
    status: 'ok',
    details: {},
  };
}

function mapGeminiQuotaResponseToSnapshot(params: Readonly<{
  profileId: string;
  fetchedAt: number;
  quotaResponse: unknown;
  staleAfterMs: number;
}>): ConnectedServiceQuotaSnapshotV1 {
  const buckets = readRecord(params.quotaResponse)?.buckets;
  const meters = Array.isArray(buckets)
    ? buckets.map(buildMeter).filter((meter): meter is ConnectedServiceQuotaMeterV1 => meter !== null)
    : [];

  return ConnectedServiceQuotaSnapshotV1Schema.parse({
    v: 1,
    serviceId: 'gemini',
    profileId: params.profileId,
    fetchedAt: Math.max(0, Math.trunc(params.fetchedAt)),
    staleAfterMs: params.staleAfterMs,
    planLabel: null,
    accountLabel: null,
    meters,
  });
}


export function createGeminiQuotaFetcher(deps: Readonly<{ fetchRuntime?: GoogleCodeAssistFetchRuntime; staleAfterMs?: number }> = {}): ConnectedServiceQuotaFetcher {
  return { serviceId: 'gemini', async fetch({ record, now, signal }) {
    if (record.serviceId !== 'gemini' || record.kind !== 'oauth' || !record.oauth.accessToken) {
      throw new ConnectedServiceQuotaFetchError('missing_gemini_oauth_record', { quotaFetchErrorCode: 'missing_auth' });
    }
    const request = { fetchRuntime: deps.fetchRuntime ?? fetch, accessToken: record.oauth.accessToken, endpoint: 'https://cloudcode-pa.googleapis.com', signal };
    const load = await requestGoogleCodeAssist({ ...request, method: 'loadCodeAssist', body: { metadata: {} } });
    const project = readString(readRecord(load)?.cloudaicompanionProject);
    if (!project) throw new ConnectedServiceQuotaFetchError('gemini_code_assist_project_unavailable', { quotaFetchErrorCode: 'malformed' });
    const quotaResponse = await requestGoogleCodeAssist({ ...request, method: 'retrieveUserQuota', body: { project } });
    if (!Array.isArray(readRecord(quotaResponse)?.buckets)) throw new ConnectedServiceQuotaFetchError('gemini_code_assist_quota_malformed', { quotaFetchErrorCode: 'malformed' });
    return mapGeminiQuotaResponseToSnapshot({ profileId: record.profileId, fetchedAt: now, quotaResponse, staleAfterMs: deps.staleAfterMs ?? 300_000 });
  } };
}
export const geminiQuotaFetcherDescriptor: ConnectedServiceQuotaFetcherDescriptor = { loadQuota: ({ staleAfterMs }) => createGeminiQuotaFetcher({ staleAfterMs }) };
