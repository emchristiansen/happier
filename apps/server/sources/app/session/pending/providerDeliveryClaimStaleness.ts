import { reofferRecoverablePendingRowsInTx } from "@/app/session/pending/reofferPendingRowAsNewInTx";
import type { Tx } from "@/storage/inTx";

/** Registration recovers stranded input before committing the successor publisher fence. */
export async function reofferInheritedProviderDeliveryClaims(params: Readonly<{
    tx: Tx;
    sessionId: string;
    now?: Date;
}>): Promise<void> {
    await reofferRecoverablePendingRowsInTx({
        ...params,
        now: params.now ?? new Date(),
        includeInheritedClaims: true,
    });
}
