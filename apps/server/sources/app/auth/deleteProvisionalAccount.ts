import { accountStandingCache } from "@/app/auth/accountStandingCache";
import { db } from "@/storage/db";

/**
 * Best-effort rollback of an account created earlier in the same signup/finalize request.
 *
 * A concurrent login for the same public key can find the account before the rollback and cache its
 * standing as active, so every rollback delete also invalidates that standing. The invalidation runs in a
 * `finally`: a delete that throws may still have committed. Delete errors are swallowed, as the rollback
 * paths did before.
 */
export async function deleteProvisionalAccount(accountId: string): Promise<void> {
    try {
        await db.account.delete({ where: { id: accountId } });
    } catch {
        // Best effort: the caller is already handling the failure that triggered the rollback.
    } finally {
        accountStandingCache.invalidate(accountId);
    }
}
