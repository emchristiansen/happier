import * as React from 'react';

import { getPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { subscribePendingSetupIntent, type PendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent.shared';

/**
 * The persisted setup intent, read reactively: writers emit through the owner, so a surface
 * conditional on a LIVE intent never shows a banner for a flow that is not running.
 */
export function usePendingSetupIntent(): PendingSetupIntent | null {
    return React.useSyncExternalStore(subscribePendingSetupIntent, getPendingSetupIntent, getPendingSetupIntent);
}
