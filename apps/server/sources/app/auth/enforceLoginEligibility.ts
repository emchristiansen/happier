import { resolveAuthPolicyFromEnv } from "@/app/auth/authPolicy";
import type { LoginEligibilityResult } from "@/app/auth/loginEligibilityResult";
import { readAccountStanding, type AccountStanding } from "@/app/auth/accountStanding";
import { accountStandingCache } from "@/app/auth/accountStandingCache";
import { findIdentityProviderById } from "@/app/auth/providers/identityProviders/registry";
import { log } from "@/utils/logging/log";

const REJECTION_BY_STANDING: Readonly<Record<Exclude<AccountStanding["kind"], "active">, LoginEligibilityResult>> = {
    "not-found": { ok: false, statusCode: 401, error: "invalid-token" },
    disabled: { ok: false, statusCode: 403, error: "account-disabled" },
    unavailable: { ok: false, statusCode: 503, error: "upstream_error" },
};

export async function enforceLoginEligibility(params: {
    accountId: string;
    env: NodeJS.ProcessEnv;
    now?: Date;
}): Promise<LoginEligibilityResult> {
    const accountId = params.accountId.toString().trim();
    if (!accountId) return { ok: false, statusCode: 401, error: "invalid-token" };

    const policy = resolveAuthPolicyFromEnv(params.env);
    // The account row and its disable marker are cached for a bounded time; see accountStandingCache.ts.
    const standing = await accountStandingCache.resolve(accountId, readAccountStanding);
    if (standing.kind !== "active") return REJECTION_BY_STANDING[standing.kind];

    if (policy.requiredLoginProviders.length === 0) {
        return { ok: true };
    }

    const now = params.now ?? new Date();
    for (const providerIdRaw of policy.requiredLoginProviders) {
        const providerId = providerIdRaw.toString().trim().toLowerCase();
        if (!providerId) continue;

        const provider = findIdentityProviderById(params.env, providerId);
        if (!provider?.enforceLoginEligibility) {
            log(
                { module: "auth-policy", level: "warn" },
                "Required login provider is not registered for eligibility enforcement",
                { providerId },
            );
            return { ok: false, statusCode: 503, error: "upstream_error" };
        }

        let result: LoginEligibilityResult;
        try {
            result = await provider.enforceLoginEligibility({
                accountId,
                env: params.env,
                policy,
                now,
            });
        } catch (error) {
            log(
                { module: "auth-login-eligibility", level: "error" },
                "Required login provider eligibility enforcement failed",
                { accountId, providerId, error },
            );
            return { ok: false, statusCode: 503, error: "upstream_error" };
        }
        if (!result.ok) return result;
    }

    return { ok: true };
}
