import {
    CURRENT_PENDING_INPUT_PROTOCOL_VERSION,
    PENDING_INPUT_EXACT_LOCAL_ID_PROTOCOL_VERSION_V1,
    SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY,
} from '@happier-dev/protocol';

import type { FeaturesPayloadDelta } from './types';

export function resolveSessionProtocolCapabilitiesFeature(): FeaturesPayloadDelta {
    return {
        capabilities: {
            session: {
                runtimeActivity: {
                    protocolVersion: SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY,
                },
                pendingInput: {
                    protocolVersion: CURRENT_PENDING_INPUT_PROTOCOL_VERSION,
                },
                pendingInputExactLocalId: {
                    protocolVersion: PENDING_INPUT_EXACT_LOCAL_ID_PROTOCOL_VERSION_V1,
                },
            },
        },
    };
}
