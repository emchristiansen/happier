import * as React from 'react';

import { desktopSetupCoordinator } from './desktopSetupCoordinator';
import type { DesktopLocalInspection } from './deriveDesktopLocalSetupSnapshot';

export type DesktopLocalInspectionState = Readonly<{
    inspection: DesktopLocalInspection;
    /**
     * Re-reads the ambient facts (INV8). The one inspection per app open is immutable on purpose
     * — a relay change re-compares against it rather than re-running it — but a caller that just
     * ran the executor changed the runtime those facts describe, so continuing to project them
     * would show the pre-repair state forever. The new read reaches every reader, not just this
     * one.
     */
    refresh: () => void;
}>;

/**
 * Reads the coordinator's one ambient inspection (plan §3.3) and re-renders when it changes.
 *
 * It is one observation, observed — not a promise each consumer snapshots for itself. That
 * distinction is the whole point of the hook: when every reader awaited the promise once and kept
 * what it saw, a fresh read by any of them reached none of the others, so the tray kept the drift
 * title it read at app open and the settings row beside a just-repaired daemon still said it was
 * not running.
 */
export function useDesktopLocalInspection(
    enabled: boolean,
    options: Readonly<{
        /**
         * Re-read once when this reader opens, after the shared read settles — for a surface the
         * person opens to look at this computer (Settings › This computer), where facts found since
         * app open (a CLI update the daily background check discovered) must show. One read per
         * mount; nothing repeats it.
         */
        refreshOnOpen?: boolean;
    }> = {},
): DesktopLocalInspectionState {
    const inspection = React.useSyncExternalStore(
        desktopSetupCoordinator.subscribe,
        desktopSetupCoordinator.readInspectionSnapshot,
        desktopSetupCoordinator.readInspectionSnapshot,
    );
    const refreshOnOpen = options.refreshOnOpen === true;
    React.useEffect(() => {
        if (!enabled) {
            return;
        }
        // Whoever mounts first starts the one read; everyone after joins it. A reader that re-reads
        // on open waits for it, so the two never run side by side.
        const shared = desktopSetupCoordinator.inspect();
        if (refreshOnOpen) {
            void shared.then(() => desktopSetupCoordinator.inspect({ fresh: true }));
        }
    }, [enabled, refreshOnOpen]);
    const refresh = React.useCallback(() => {
        void desktopSetupCoordinator.inspect({ fresh: true });
    }, []);
    return { inspection, refresh };
}
