import {
    isConnectedServiceCredentialMetadataV2,
    normalizeConnectedServiceCredentialMetadataV2,
    type ConnectedServiceCredentialMetadataV2,
} from "./connectedServicesV2/credentialMetadataV2";
import {
    isConnectedServiceCredentialMetadataV3,
    normalizeConnectedServiceCredentialMetadataV3,
    type ConnectedServiceCredentialMetadataV3,
} from "./connectedServicesV3/credentialMetadataV3";

/**
 * Reads one stored credential row's metadata in either released envelope (v2 sealed or v3
 * server-stored), with health normalized. Returns null for any other shape, which the
 * canonical status owner reports as `needs_reauth`.
 */
export function readStoredConnectedServiceCredentialMetadata(
    raw: unknown,
): ConnectedServiceCredentialMetadataV2 | ConnectedServiceCredentialMetadataV3 | null {
    if (isConnectedServiceCredentialMetadataV2(raw)) return normalizeConnectedServiceCredentialMetadataV2(raw);
    if (isConnectedServiceCredentialMetadataV3(raw)) return normalizeConnectedServiceCredentialMetadataV3(raw);
    return null;
}
