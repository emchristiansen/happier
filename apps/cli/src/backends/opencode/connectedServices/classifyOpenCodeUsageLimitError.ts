import type { ConnectedServiceLimitCategoryV1 } from '@happier-dev/protocol';

import { parseProviderResetAt } from '@/daemon/connectedServices/quotas/normalization';

export type OpenCodeUsageLimitClassification = Readonly<{
  kind: 'usage_limit' | 'rate_limit';
  limitCategory: Extract<ConnectedServiceLimitCategoryV1, 'usage_limit' | 'rate_limit'>;
  retryAfterMs: number | null;
  resetAtMs: number | null;
  quotaScope: 'account' | 'workspace' | 'unknown';
  providerLimitId: string | null;
  action: Readonly<{ kind: 'open_url'; url: string }> | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readErrorName(record: Record<string, unknown>): string | null {
  return readString(record.name) ?? readString(record.code) ?? readString(record.type) ?? readString(record.reason);
}

export function classifyOpenCodeUsageLimitError(params: Readonly<{
  providerErrorPath: boolean;
  error: unknown;
  now?: number;
}>): OpenCodeUsageLimitClassification | null {
  if (!params.providerErrorPath) return null;
  const record = isRecord(params.error) ? params.error : null;
  if (!record) return null;
  const name = readErrorName(record);
  if (name !== 'FreeUsageLimitError' && name !== 'GoUsageLimitError') return null;

  const metadata = isRecord(record.metadata) ? record.metadata : {};
  const retry = parseProviderResetAt({
    headers: record.headers,
    body: record,
    nowMs: params.now ?? Date.now(),
  });
  if (name === 'FreeUsageLimitError') {
    return {
      kind: 'usage_limit',
      limitCategory: 'usage_limit',
      retryAfterMs: retry.retryAfterMs,
      resetAtMs: retry.resetAtMs,
      quotaScope: 'account',
      providerLimitId: null,
      action: null,
    };
  }

  const action = isRecord(record.action) ? record.action : {};
  const actionUrl = readString(action.url);
  return {
    kind: 'rate_limit',
    limitCategory: 'rate_limit',
    retryAfterMs: retry.retryAfterMs,
    resetAtMs: retry.resetAtMs,
    quotaScope: readString(metadata.workspace) ? 'workspace' : 'account',
    providerLimitId: readString(metadata.limitName ?? metadata.limit_name),
    action: actionUrl ? { kind: 'open_url', url: actionUrl } : null,
  };
}
