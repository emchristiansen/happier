import { isAccountDisabled } from "@/app/auth/accountDisable";
import { db } from "@/storage/db";
import { log } from "@/utils/logging/log";

/**
 * What login eligibility needs to know about an account before any identity-provider check:
 * whether the account row exists and whether its disable marker is currently in force.
 */
export type AccountStanding =
    | { readonly kind: "active" }
    | { readonly kind: "not-found" }
    | { readonly kind: "disabled" }
    | { readonly kind: "unavailable" };

/**
 * Reads an account's standing with two statements: `account.findUnique` by id, then the
 * `auth_disabled_<id>` repeat-key marker. A failed statement yields "unavailable" (callers fail closed).
 */
export async function readAccountStanding(accountId: string): Promise<AccountStanding> {
    let account: { id: string } | null = null;
    try {
        account = await db.account.findUnique({
            where: { id: accountId },
            select: { id: true },
        });
    } catch (error) {
        log(
            { module: "auth-login-eligibility", level: "error" },
            "Failed to look up account for eligibility enforcement",
            { accountId, error },
        );
        return { kind: "unavailable" };
    }
    if (!account) return { kind: "not-found" };

    try {
        return (await isAccountDisabled({ accountId: account.id })) ? { kind: "disabled" } : { kind: "active" };
    } catch (error) {
        log(
            { module: "auth-login-eligibility", level: "error" },
            "Failed to check account disabled status",
            { accountId: account.id, error },
        );
        return { kind: "unavailable" };
    }
}
