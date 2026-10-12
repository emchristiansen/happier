import { createHash } from 'node:crypto';

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableJsonValue(entry)]),
  );
}

export function fingerprintExecutionRunStartRequest(request: unknown): string {
  const requestRecord = request && typeof request === 'object' && !Array.isArray(request)
    ? request as Record<string, unknown>
    : null;
  const fingerprintInput = requestRecord
    ? Object.fromEntries(
        Object.entries(requestRecord).filter(
          ([key]) => key !== 'startRequestId' && key !== 'startRequestFingerprint',
        ),
      )
    : request;
  return createHash('sha256').update(JSON.stringify(stableJsonValue(fingerprintInput))).digest('hex');
}
