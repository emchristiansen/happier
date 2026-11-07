import * as React from 'react';

import { desktopSetupCoordinator } from './desktopSetupCoordinator';

/**
 * R5/INV4 — the pre-auth warm-up.
 *
 * The desktop app starts the one ambient inspection as soon as it opens, before anyone has
 * signed in, so the moment the user finishes signing in the work is already done or in flight.
 * `daemon.service.status.v1` is exactly both halves the requirement asks for: the runner acquires
 * and installs the managed CLI before every command, and the command itself reads what the local
 * daemon is doing. Both are local Tauri IPC to the bundled sidecar and need no account, no relay
 * and no server round trip.
 *
 * This is a mount point, not a second inspection owner: it calls the coordinator's one memoized
 * `inspect()`, so the authenticated gate later awaits the same promise instead of starting its
 * own read. Nothing is rendered and nothing is reported — a pre-auth failure stays invisible
 * (INV4) and the gate re-runs it visibly once the user has committed to setup.
 */
export function DesktopLocalSetupWarmup(props: Readonly<{ enabled: boolean }>): null {
    const { enabled } = props;
    React.useEffect(() => {
        if (!enabled) {
            return;
        }
        // `inspect()` resolves to a `failed` inspection rather than rejecting, so there is no
        // rejection to swallow here and no unobserved failure path.
        void desktopSetupCoordinator.inspect();
    }, [enabled]);
    return null;
}
