import { createServerUrlComparableKey } from '@happier-dev/protocol';

/**
 * The repair every drift status offers: the one desktop setup executor (`setup.thisComputer.v1`),
 * started through `desktopSetupCoordinator` like every other caller (SB6).
 */
export type RelayDriftRepairAction = Readonly<{
    kind: 'setupThisComputer';
}>;

export type RelayDriftClassification =
    | Readonly<{ status: 'aligned'; repairAction: null }>
    | Readonly<{ status: 'daemon_not_configured'; repairAction: RelayDriftRepairAction }>
    | Readonly<{ status: 'daemon_not_installed'; repairAction: RelayDriftRepairAction }>
    | Readonly<{ status: 'daemon_not_running'; repairAction: RelayDriftRepairAction }>
    | Readonly<{ status: 'daemon_url_mismatch'; repairAction: RelayDriftRepairAction }>
    | Readonly<{ status: 'daemon_needs_auth'; repairAction: RelayDriftRepairAction }>
    /**
     * The daemon is healthy on this relay but paired to a different account than the app. The
     * repair is the same one every other status offers — connect this computer's background
     * service to the relay and account the app is on — but the state is worth its own name: the
     * daemon is authenticated, so "needs to sign in" would be untrue, and saying nothing at all
     * left the only re-offer of setup to a relaunch.
     */
    | Readonly<{ status: 'daemon_account_mismatch'; repairAction: RelayDriftRepairAction }>;

export function createRelayUrlComparableKeySafe(rawUrl: string | null | undefined): string | null {
    const value = String(rawUrl ?? '').trim();
    if (!value) return null;
    try {
        return createServerUrlComparableKey(value);
    } catch {
        return null;
    }
}

export function resolveKnownRelayEquivalentUrl(params: Readonly<{
    activeRelayUrl: string | null | undefined;
    daemonRelayUrl: string | null | undefined;
    daemonAlternateRelayUrls?: readonly (string | null | undefined)[];
}>): string | null {
    const activeRelayKey = createRelayUrlComparableKeySafe(params.activeRelayUrl);
    if (!activeRelayKey) {
        return null;
    }

    const candidates = [
        params.daemonRelayUrl,
        ...(params.daemonAlternateRelayUrls ?? []),
    ];

    const keyedCandidates = candidates
        .map((url) => {
            const normalizedUrl = typeof url === 'string' ? url.trim() : '';
            const key = createRelayUrlComparableKeySafe(normalizedUrl);
            return normalizedUrl && key ? { url: normalizedUrl, key } : null;
        })
        .filter((candidate): candidate is { url: string; key: string } => candidate != null);

    const matchingCandidate = keyedCandidates.find((candidate) => candidate.key === activeRelayKey);
    if (!matchingCandidate) {
        return null;
    }

    const alternateCandidate = keyedCandidates.find((candidate) => candidate.key !== matchingCandidate.key);
    return alternateCandidate?.url ?? null;
}

export function classifyRelayDrift(params: Readonly<{
    activeRelayUrl: string | null | undefined;
    activeLocalRelayUrl?: string | null | undefined;
    daemonRelayUrl: string | null | undefined;
    daemonAlternateRelayUrls?: readonly (string | null | undefined)[];
    daemonAccountId: string | null | undefined;
    /**
     * The account the APP is signed in to on this relay. `null`/absent means the app has no
     * account to compare — signed out, or a relay it has not authenticated against — and nothing
     * the daemon reports can contradict it.
     */
    appAccountId?: string | null | undefined;
    daemonNeedsAuth?: boolean | null | undefined;
    /**
     * U9 — the daemon's credentials could not be checked at all (the relay did not answer). That
     * says nothing about them, so a daemon with no validated account is not "needs to sign in".
     */
    daemonAuthUnverified?: boolean | null | undefined;
    daemonServiceInstalled?: boolean | null | undefined;
    daemonRunning?: boolean | null | undefined;
}>): RelayDriftClassification {
    const activeRelayKey = createRelayUrlComparableKeySafe(params.activeRelayUrl);
    if (!activeRelayKey) {
        return { status: 'aligned', repairAction: null };
    }

    const acceptedRelayKeys = new Set<string>([activeRelayKey]);
    const activeLocalRelayKey = createRelayUrlComparableKeySafe(params.activeLocalRelayUrl);
    if (activeLocalRelayKey) {
        acceptedRelayKeys.add(activeLocalRelayKey);
    }

    const daemonRelayKeys = new Set<string>();
    const primaryDaemonRelayKey = createRelayUrlComparableKeySafe(params.daemonRelayUrl);
    if (primaryDaemonRelayKey) {
        daemonRelayKeys.add(primaryDaemonRelayKey);
    }
    for (const candidate of params.daemonAlternateRelayUrls ?? []) {
        const candidateKey = createRelayUrlComparableKeySafe(candidate);
        if (candidateKey) {
            daemonRelayKeys.add(candidateKey);
        }
    }

    if (daemonRelayKeys.size === 0) {
        return {
            status: 'daemon_not_configured',
            repairAction: { kind: 'setupThisComputer' },
        };
    }

    const isAligned = [...daemonRelayKeys].some((daemonRelayKey) => acceptedRelayKeys.has(daemonRelayKey));
    if (!isAligned) {
        return {
            status: 'daemon_url_mismatch',
            repairAction: { kind: 'setupThisComputer' },
        };
    }

    if (params.daemonServiceInstalled === false) {
        return {
            status: 'daemon_not_installed',
            repairAction: { kind: 'setupThisComputer' },
        };
    }

    if (params.daemonServiceInstalled === true && params.daemonRunning === false) {
        return {
            status: 'daemon_not_running',
            repairAction: { kind: 'setupThisComputer' },
        };
    }

    if (params.daemonNeedsAuth === true) {
        return {
            status: 'daemon_needs_auth',
            repairAction: { kind: 'setupThisComputer' },
        };
    }

    const daemonAccountId = String(params.daemonAccountId ?? '').trim();
    if (!daemonAccountId && params.daemonAuthUnverified === true) {
        return { status: 'aligned', repairAction: null };
    }
    if (!daemonAccountId) {
        return {
            status: 'daemon_needs_auth',
            repairAction: { kind: 'setupThisComputer' },
        };
    }

    const appAccountId = String(params.appAccountId ?? '').trim();
    if (appAccountId && daemonAccountId !== appAccountId) {
        return {
            status: 'daemon_account_mismatch',
            repairAction: { kind: 'setupThisComputer' },
        };
    }

    return { status: 'aligned', repairAction: null };
}
