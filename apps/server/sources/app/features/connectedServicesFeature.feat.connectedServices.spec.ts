import { describe, expect, it } from "vitest";
import { ConnectedServiceIdSchema } from "@happier-dev/protocol";

import { resolveConnectedServicesFeature } from "./connectedServicesFeature";

describe("resolveConnectedServicesFeature", () => {
    it("defaults to connected services enabled (including quotas and account groups)", () => {
        const feature = resolveConnectedServicesFeature({} as NodeJS.ProcessEnv);

        expect(feature.features?.connectedServices).toEqual({
            enabled: true,
            quotas: { enabled: true },
            quotaRecoveryCreditDetails: { enabled: true },
            subscription: { enabled: true },
            accountGroups: { enabled: true },
            accountFallback: { enabled: true },
            autoQuotaReset: { enabled: true },
            autoDisablePlanInvalid: { enabled: true },
            poolQuotaLimitSelection: { enabled: true },
            poolExpiryFirst: { enabled: true },
            poolPerSessionSoftmax: { enabled: false },
        });
        expect(feature.capabilities?.connectedServices).toEqual({
            supportedServiceIds: ConnectedServiceIdSchema.options,
            credentialDelete: { revisionGuard: true },
            credentialWrite: { revisionGuard: true },
        });
    });

    it("reads child enablement independently from connected services enablement", () => {
        const feature = resolveConnectedServicesFeature({
            HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: "0",
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1",
            HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: "1",
            HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_FALLBACK__ENABLED: "1",
        } as NodeJS.ProcessEnv);

        expect(feature.features?.connectedServices).toEqual({
            enabled: false,
            quotas: { enabled: true },
            quotaRecoveryCreditDetails: { enabled: true },
            subscription: { enabled: true },
            accountGroups: { enabled: true },
            accountFallback: { enabled: true },
            autoQuotaReset: { enabled: true },
            autoDisablePlanInvalid: { enabled: true },
            poolQuotaLimitSelection: { enabled: true },
            poolExpiryFirst: { enabled: true },
            poolPerSessionSoftmax: { enabled: false },
        });
    });

    it("reads disabled account group env values", () => {
        const feature = resolveConnectedServicesFeature({
            HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: "0",
            HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_FALLBACK__ENABLED: "0",
        } as NodeJS.ProcessEnv);

        expect(feature.features?.connectedServices).toEqual({
            enabled: true,
            quotas: { enabled: true },
            quotaRecoveryCreditDetails: { enabled: true },
            subscription: { enabled: true },
            accountGroups: { enabled: false },
            accountFallback: { enabled: false },
            autoQuotaReset: { enabled: true },
            autoDisablePlanInvalid: { enabled: true },
            poolQuotaLimitSelection: { enabled: true },
            poolExpiryFirst: { enabled: true },
            poolPerSessionSoftmax: { enabled: false },
        });
    });

    it("enables the per-session softmax pool strategy only through its explicit env key", () => {
        const feature = resolveConnectedServicesFeature({
            HAPPIER_FEATURE_CONNECTED_SERVICES_POOL_PER_SESSION_SOFTMAX__ENABLED: "1",
        } as NodeJS.ProcessEnv);

        expect(feature.features?.connectedServices?.poolPerSessionSoftmax).toEqual({ enabled: true });
    });
});
