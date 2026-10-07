import { createRelayUrlComparableKeySafe } from '@/sync/domains/server/relayDrift/relayDriftModel';
import { toRelayHostDisplay } from '@/sync/domains/server/url/serverUrlDisplay';

import {
    daemonRelayMatchesExpectation,
    relayUrlMatchesExpectation,
    resolveThisComputerRelayState,
    resolveThisComputerService,
    type DesktopLocalInspection,
    type DesktopSetupExpectation,
    type ThisComputerRelayState,
    type ThisComputerServiceRowFacts,
} from './deriveDesktopLocalSetupSnapshot';

/** One background service on this computer, one relay, as every surface that lists them reads it. */
export type ThisComputerRelayRow = Readonly<{
    relayUrl: string;
    /** The relay's host as the app shows it. */
    host: string;
    state: ThisComputerRelayState;
    /** The relay the app is on — the row judged against the app's own account. */
    appRelay: boolean;
    /** R15/H2 — the app starts, stops and restarts it; a service the user set up is shown only. */
    appManaged: boolean;
    /** What the app may do from the row (the executor decides; the app only renders it). */
    actions: ThisComputerServiceRowFacts['actions'];
}>;

export type ThisComputerRelayRows =
    | Readonly<{ status: 'pending' }>
    | Readonly<{ status: 'failed' }>
    | Readonly<{
        status: 'listed';
        rows: readonly ThisComputerRelayRow[];
        /** `true` only when every service here was read (the executor's one signal), so "none" is never implied (M6). */
        complete: boolean;
    }>;

/**
 * M4/R15 (d)/R16 — the rows the connection popover and the tray show for this computer. The rows
 * themselves — which services exist, their state against each relay's own account, who manages
 * them, what may be done — are the executor's (`daemon.service.status.v1` → `serviceRows`), the
 * same rows the native tray renders in menu-bar mode. The app adds only what it alone knows: the
 * row of the relay it is on is judged again against the account it is signed in as.
 */
export function listThisComputerRelayRows(
    inspection: DesktopLocalInspection,
    appRelay: DesktopSetupExpectation | null,
): ThisComputerRelayRows {
    if (inspection.status === 'pending') return { status: 'pending' };
    if (inspection.status === 'failed' || !inspection.serviceRows) return { status: 'failed' };
    const serving = appRelay ? resolveThisComputerService(inspection, appRelay)?.facts ?? null : null;
    // The daemon serving the app's relay may report that relay under another of its URLs (public
    // or local), so its row is found by the serving daemon's own relay as well as by the app's.
    const servingKey = appRelay && serving && daemonRelayMatchesExpectation(serving, appRelay)
        ? createRelayUrlComparableKeySafe(serving.server.serverUrl) || null
        : null;
    const rows: ThisComputerRelayRow[] = [];
    const seen = new Set<string>();
    for (const row of inspection.serviceRows) {
        const host = toRelayHostDisplay(row.relayUrl);
        // C9 — one row per relay, by the same comparable key bootstrap lists them by, so two
        // spellings of one relay never read as two services (nor two relays on one host as one).
        const key = createRelayUrlComparableKeySafe(row.relayUrl) || row.relayUrl;
        if (!host || seen.has(key)) continue;
        seen.add(key);
        const isAppRelay = appRelay !== null && ((servingKey !== null && key === servingKey) || relayUrlMatchesExpectation(row.relayUrl, appRelay));
        const state = isAppRelay && servingKey !== null && serving && appRelay
            ? resolveThisComputerRelayState(serving, appRelay)
            : row.state;
        rows.push({ relayUrl: row.relayUrl, host, state, appRelay: isAppRelay, appManaged: row.appManaged, actions: row.actions });
    }
    return { status: 'listed', rows, complete: inspection.pinnedServicesComplete === true };
}
