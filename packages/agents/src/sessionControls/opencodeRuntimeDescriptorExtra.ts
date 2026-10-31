import {
  normalizeOpenCodeBackendMode,
  normalizeOpenCodeServerBaseUrl,
  normalizeOpenCodeServerBaseUrlExplicit,
  type OpenCodeBackendMode,
} from '../providerSettings/definitions/opencode.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeOptionalOpenCodeBackendMode(value: unknown): OpenCodeBackendMode | null {
  if (value === 'server' || value === 'acp') return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed === 'server' || trimmed === 'acp' ? trimmed : null;
}

export type OpenCodeRuntimeDescriptorProviderExtraRuntimeHandle = Readonly<{
  backendMode: OpenCodeBackendMode | null;
  vendorSessionId: string | null;
  serverBaseUrl: string | null;
  serverBaseUrlExplicit: boolean;
  managedServerLaunchFingerprint: string | null;
}>;

export type OpenCodeRuntimeDescriptorProviderExtra = Readonly<{
  v: 1;
  runtimeHandle?: Readonly<{
    backendMode?: OpenCodeBackendMode;
    vendorSessionId?: string;
    serverBaseUrl?: string;
    serverBaseUrlExplicit?: true;
    managedServerLaunchFingerprint?: string;
  }>;
}>;

export function buildOpenCodeRuntimeDescriptorProviderExtra(
  params: Readonly<{
    backendMode?: OpenCodeBackendMode | null;
    vendorSessionId?: string | null;
    serverBaseUrl?: string | null;
    serverBaseUrlExplicit?: boolean;
    managedServerLaunchFingerprint?: string | null;
  }>,
): OpenCodeRuntimeDescriptorProviderExtra {
  const backendMode = normalizeOpenCodeBackendMode(params.backendMode);
  const vendorSessionId = normalizeTrimmedString(params.vendorSessionId);
  const serverBaseUrlExplicit = normalizeOpenCodeServerBaseUrlExplicit(params.serverBaseUrlExplicit);
  const serverBaseUrl = serverBaseUrlExplicit ? normalizeOpenCodeServerBaseUrl(params.serverBaseUrl) : null;
  const managedServerLaunchFingerprint = backendMode === 'server' && !serverBaseUrlExplicit
    ? normalizeTrimmedString(params.managedServerLaunchFingerprint) : null;

  return {
    v: 1,
    runtimeHandle: {
      ...(backendMode ? { backendMode } : {}),
      ...(vendorSessionId ? { vendorSessionId } : {}),
      ...(serverBaseUrl ? { serverBaseUrl } : {}),
      ...(serverBaseUrl && serverBaseUrlExplicit ? { serverBaseUrlExplicit: true } : {}),
      ...(managedServerLaunchFingerprint ? { managedServerLaunchFingerprint } : {}),
    },
  };
}

export function readOpenCodeRuntimeDescriptorProviderExtra(
  value: unknown,
): OpenCodeRuntimeDescriptorProviderExtraRuntimeHandle | null {
  const extra = asRecord(value);
  if (!extra || extra.v !== 1) return null;

  const runtimeHandle = asRecord(extra.runtimeHandle);
  if (!runtimeHandle) return null;

  const normalizedRuntimeHandle = {
    backendMode: normalizeOptionalOpenCodeBackendMode(runtimeHandle.backendMode),
    vendorSessionId: normalizeTrimmedString(runtimeHandle.vendorSessionId),
    serverBaseUrl: normalizeOpenCodeServerBaseUrl(runtimeHandle.serverBaseUrl),
    serverBaseUrlExplicit: normalizeOpenCodeServerBaseUrlExplicit(runtimeHandle.serverBaseUrlExplicit),
    // Preserve present malformed affinity as invalid (empty), not absent. The state owner
    // validates the fingerprint before filesystem lookup; invalid intent must not use ambient state.
    managedServerLaunchFingerprint: runtimeHandle.managedServerLaunchFingerprint == null ? null
      : typeof runtimeHandle.managedServerLaunchFingerprint === 'string' ? runtimeHandle.managedServerLaunchFingerprint.trim() : '',
  } satisfies OpenCodeRuntimeDescriptorProviderExtraRuntimeHandle;

  if (
    !normalizedRuntimeHandle.backendMode &&
    !normalizedRuntimeHandle.vendorSessionId &&
    !normalizedRuntimeHandle.serverBaseUrl &&
    normalizedRuntimeHandle.managedServerLaunchFingerprint === null
  ) {
    return null;
  }

  return normalizedRuntimeHandle;
}
