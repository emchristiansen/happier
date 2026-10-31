import type { FeaturesPayloadDelta } from "./types";
import { ConnectedServiceIdSchema } from "@happier-dev/protocol";
import { readConnectedServicesFeatureEnv } from "./catalog/readFeatureEnv";

export function resolveConnectedServicesFeature(
    env: NodeJS.ProcessEnv,
): FeaturesPayloadDelta {
    const featureEnv = readConnectedServicesFeatureEnv(env);
    const enabled = featureEnv.enabled;
    const quotasEnabled = featureEnv.quotasEnabled;
    const accountGroupsEnabled = featureEnv.accountGroupsEnabled;
    const accountFallbackEnabled = featureEnv.accountFallbackEnabled;

    return {
        features: {
            connectedServices: {
                enabled,
                quotas: { enabled: quotasEnabled },
                quotaRecoveryCreditDetails: { enabled: true },
                subscription: { enabled: true },
                accountGroups: { enabled: accountGroupsEnabled },
                accountFallback: { enabled: accountFallbackEnabled },
                autoQuotaReset: { enabled: true },
                autoDisablePlanInvalid: { enabled: true },
                poolQuotaLimitSelection: { enabled: true },
                poolExpiryFirst: { enabled: true },
            },
        },
        capabilities: {
            connectedServices: {
                supportedServiceIds: ConnectedServiceIdSchema.options,
                credentialDelete: { revisionGuard: true },
                credentialWrite: { revisionGuard: true },
            },
        },
    };
}
