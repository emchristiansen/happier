import type { CapabilitiesDetectRequest, CapabilityDetectResult, CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import { AGY_ACP_SERVER_DEP_ID } from '@happier-dev/protocol/installables';

export function getAgyAcpDetectResult(
    results: Partial<Record<CapabilityId, CapabilityDetectResult>> | null | undefined,
): CapabilityDetectResult | null {
    const res = results?.[AGY_ACP_SERVER_DEP_ID];
    return res ? res : null;
}

export function getAgyAcpDepData(
    results: Partial<Record<CapabilityId, CapabilityDetectResult>> | null | undefined,
): Record<string, unknown> | null {
    const result = getAgyAcpDetectResult(results);
    if (!result || result.ok !== true) return null;
    const data = (result as { data?: unknown }).data;
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
}

export function shouldPrefetchAgyAcpLatestVersion(): boolean {
    // Pinned v1.1.1 archive: no latest-version polling. Install state is the whole truth.
    return false;
}

export function buildAgyAcpLatestVersionDetectRequest(): CapabilitiesDetectRequest {
    return {
        requests: [
            {
                id: AGY_ACP_SERVER_DEP_ID,
                params: { includeLatestVersion: true, onlyIfInstalled: true },
            },
        ],
    };
}
