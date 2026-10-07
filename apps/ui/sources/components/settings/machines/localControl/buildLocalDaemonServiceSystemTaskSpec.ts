import { SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskSpec } from '@happier-dev/protocol';

import type { DesktopBackgroundServiceAutostartMode } from '@/setup/deriveDesktopLocalSetupSnapshot';
import { resolvePreferredPublicReleaseRingLabelForCurrentApp } from '@/sync/runtime/currentAppVariant';

type LocalDaemonServiceTaskKind =
    | 'daemon.service.status.v1'
    | 'daemon.service.start.v1'
    | 'daemon.service.stop.v1'
    | 'daemon.service.autostart.set.v1'
    // H3 — this computer stops answering on one relay: its desktop-managed service is uninstalled.
    | 'daemon.service.relay.disconnect.v1'
    // K2/R17 — updates the desktop-managed CLI of the app's channel through the acquisition owner,
    // then restarts a running service daemon. The executor refuses a CLI the app did not place.
    | 'cli.update.v1'
    | 'cli.pathExposure.ensure.v1'
    | 'cli.pathExposure.remove.v1';

/**
 * Local task params carry the app's release ring so the executor acquires the managed CLI
 * from that ring. They never carry a relay: local inspection is ambient by design (plan D3).
 */
export function buildLocalDaemonServiceSystemTaskSpec(
    kind: LocalDaemonServiceTaskKind,
    /**
     * `daemon.service.autostart.set.v1` is the only kind that carries a value, and it is always
     * explicit: the executor refuses a missing one rather than picking a side of a choice that
     * decides whether this computer answers while the app is closed. It states the mode in the
     * CLI's own vocabulary, so nothing between here and the service definition translates it.
     */
    options?: Readonly<{ autostart: DesktopBackgroundServiceAutostartMode }> | Readonly<{ relayUrl: string }>,
): SystemTaskSpec {
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind,
        params: {
            target: { kind: 'local' },
            surface: 'desktop.ui',
            mode: 'user',
            channel: resolvePreferredPublicReleaseRingLabelForCurrentApp(),
            ...(options && 'autostart' in options ? { autostart: options.autostart } : {}),
            ...(options && 'relayUrl' in options ? { relayUrl: options.relayUrl } : {}),
        },
    };
}
