import * as React from 'react';

import { usePrimaryMachineFromActiveSelection } from '@/components/settings/server/hooks/usePrimaryMachineFromActiveSelection';
import { readCachedMachineDoctorSnapshot } from '@/components/settings/systemStatus/cache/machineDoctorSnapshotCache';
import {
    daemonNeedsAuthFromFacts,
    resolveThisComputerService,
    type DesktopLocalInspection,
    type DesktopSetupExpectation,
} from '@/setup/deriveDesktopLocalSetupSnapshot';
import { resolveAppAccountLabel, resolveDaemonAccountLabel } from '@/setup/thisComputerLabels';
import { useDesktopLocalInspection } from '@/setup/useDesktopLocalInspection';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { classifyRelayDrift, createRelayUrlComparableKeySafe, resolveKnownRelayEquivalentUrl } from '@/sync/domains/server/relayDrift/relayDriftModel';
import { getActiveServerSnapshot, getWebSameOriginServerUrl } from '@/sync/domains/server/serverProfiles';
import { toRelayHostDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { t } from '@/text';
import { isTauriDesktop } from '@/utils/platform/tauri';

import type { RelayDriftSummary } from './relayDriftTypes';

/**
 * What the classifier needs to know about a daemon. On desktop these come from the ambient
 * local inspection (the running daemon); elsewhere from the remote doctor cache (SB2).
 */
type DaemonDriftFacts = Readonly<{
    relayUrl: string | null;
    alternateRelayUrls: readonly (string | null)[];
    accountId: string | null;
    /**
     * The app's own account, when the daemon account above is comparable with it. Only the local
     * inspection supplies one: it is the relay-validated account of the daemon on THIS computer,
     * which is the one the app could be contradicting. The doctor cache describes another machine
     * through a different field and stays exactly as it was (SB2).
     */
    appAccountId: string | null;
    /** How the daemon's account reads (K1 label, else a short id). Local facts only. */
    accountLabel: string | null;
    /**
     * Whether these facts are about the computer the app runs on (desktop's own inspection) or
     * about another machine (the web's doctor cache) — the copy must not say "this computer" for
     * someone else's.
     */
    describesThisComputer: boolean;
    needsAuth: boolean | undefined;
    /** U9 — the relay could not be asked about the credentials at all. */
    authUnverified: boolean;
    serviceInstalled: boolean | undefined;
    running: boolean | undefined;
}>;

function daemonFactsFromLocalInspection(
    inspection: DesktopLocalInspection,
    appRelay: DesktopSetupExpectation,
): DaemonDriftFacts | null {
    if (inspection.status !== 'resolved') {
        return null;
    }
    const appAccountId = appRelay.accountId;
    // The daemon that answers for the app's relay: the relay's own pinned service when it has one
    // here (one daemon per relay), else the default-following one — the same answer readiness and
    // the move question use, so a relay this computer also serves never reads as drift.
    const service = resolveThisComputerService(inspection, appRelay);
    if (!service) {
        // R12-F1 — the relay's own service here could not be read: no drift is claimed about it;
        // the setup panel says the read failed.
        return null;
    }
    const facts = service.facts;
    const controlReachable = facts.runtimeConvergence?.controlReachable ?? false;
    // R10 — knowing a daemon means one exists here: an installed background service, or a daemon
    // answering control. A computer with neither has nothing that could have drifted, and the
    // relay in the CLI's config file is a default, not knowledge of a daemon. Acquiring the first
    // daemon belongs to the setup gate (R2/R14), and the neutral local-daemon status already
    // states the fact, so a warning here would only nag about an ordinary first-run state.
    if (!facts.service.installed && !controlReachable) {
        return null;
    }
    return {
        relayUrl: facts.server.serverUrl,
        alternateRelayUrls: [facts.server.publicServerUrl, facts.server.localServerUrl],
        accountId: facts.auth.validatedAccountId,
        appAccountId,
        accountLabel: resolveDaemonAccountLabel(facts.auth),
        describesThisComputer: true,
        needsAuth: daemonNeedsAuthFromFacts(facts),
        authUnverified: facts.auth.credentialState === 'unknown',
        serviceInstalled: facts.service.installed,
        running: controlReachable,
    };
}

function daemonFactsFromDoctorSnapshot(cachedDoctorSnapshot: ReturnType<typeof readCachedMachineDoctorSnapshot>): DaemonDriftFacts | null {
    if (!cachedDoctorSnapshot) {
        return null;
    }
    const daemonSnapshot = cachedDoctorSnapshot.snapshot.daemonStatus;
    return {
        relayUrl: daemonSnapshot?.server.serverUrl ?? cachedDoctorSnapshot.snapshot.server.serverUrl ?? null,
        alternateRelayUrls: [daemonSnapshot?.server.publicServerUrl ?? cachedDoctorSnapshot.snapshot.server.publicServerUrl ?? null],
        accountId: daemonSnapshot?.auth.accountId ?? cachedDoctorSnapshot.snapshot.accountId ?? null,
        appAccountId: null,
        accountLabel: null,
        describesThisComputer: false,
        needsAuth: daemonSnapshot?.auth.needsAuth,
        authUnverified: false,
        serviceInstalled: daemonSnapshot?.service.installed,
        running: daemonSnapshot?.service.running,
    };
}

function resolveDoctorLocalRelayCandidate(params: Readonly<{
    activeRelayUrl: string;
    doctorSnapshot: ReturnType<typeof readCachedMachineDoctorSnapshot>;
}>): string | null {
    const doctorServer = params.doctorSnapshot?.snapshot.server;
    if (!doctorServer) {
        return null;
    }

    const activeRelayKey = createRelayUrlComparableKeySafe(params.activeRelayUrl);
    if (!activeRelayKey) {
        return null;
    }
    const doctorPublicRelayKey = createRelayUrlComparableKeySafe(doctorServer.publicServerUrl);
    const doctorServerUrl = typeof doctorServer.serverUrl === 'string' ? doctorServer.serverUrl.trim() : '';
    const knownPair = doctorPublicRelayKey
        ? resolveKnownRelayEquivalentUrl({
            activeRelayUrl: params.activeRelayUrl,
            daemonRelayUrl: doctorServerUrl,
            daemonAlternateRelayUrls: [doctorServer.publicServerUrl],
        })
        : null;
    if (knownPair) {
        return knownPair;
    }

    const appSameOriginRelayKey = createRelayUrlComparableKeySafe(getWebSameOriginServerUrl());
    const candidates = [doctorServer.serverUrl, doctorServer.webappUrl];
    for (const candidate of candidates) {
        const normalizedCandidate = typeof candidate === 'string' ? candidate.trim() : '';
        if (!normalizedCandidate) continue;
        const candidateKey = createRelayUrlComparableKeySafe(normalizedCandidate);
        if (!candidateKey || candidateKey === activeRelayKey) continue;
        if (!doctorPublicRelayKey && appSameOriginRelayKey && appSameOriginRelayKey === candidateKey) {
            return normalizedCandidate;
        }
    }

    return null;
}

/**
 * The classification and its words: one title, one sentence naming the relay host and account, one
 * action. Pure, so the desktop and web readers below cannot describe the same facts differently.
 */
function describeRelayDrift(
    daemonFacts: DaemonDriftFacts | null,
    activeServerUrl: string,
    activeLocalRelayUrl: string | null,
): RelayDriftSummary | null {
    // R10: no daemon knowledge, no banner — on desktop the facts are the local inspection,
    // and a first-run machine has none until it resolves.
    if (!daemonFacts) {
        return null;
    }
    const classification = classifyRelayDrift({
        activeRelayUrl: activeServerUrl,
        activeLocalRelayUrl,
        daemonRelayUrl: daemonFacts.relayUrl,
        daemonAlternateRelayUrls: daemonFacts.alternateRelayUrls,
        daemonAccountId: daemonFacts.accountId,
        appAccountId: daemonFacts.appAccountId,
        daemonNeedsAuth: daemonFacts.needsAuth,
        daemonAuthUnverified: daemonFacts.authUnverified,
        daemonServiceInstalled: daemonFacts.serviceInstalled,
        daemonRunning: daemonFacts.running,
    });

    if (classification.status === 'aligned' || classification.repairAction == null) {
        return null;
    }

    // Relays are named the way a person says them (`api.happier.dev`), never as full URLs,
    // and accounts by a readable label (R17).
    const daemonRelayUrl = daemonFacts.relayUrl;
    const appRelayHost = toRelayHostDisplay(activeServerUrl);
    const daemonRelayHost = daemonRelayUrl ? toRelayHostDisplay(daemonRelayUrl) : null;

    let title: string;
    let description: string;
    switch (classification.status) {
        case 'daemon_url_mismatch':
            title = t('server.relayDrift.bannerDifferentRelayTitle');
            description = !daemonFacts.describesThisComputer
                ? t('server.relayDrift.serviceConnectedElsewhere', { relay: daemonRelayHost ?? t('server.relayDrift.statusUnknown') })
                : daemonFacts.accountLabel
                ? t('server.relayDrift.connectedElsewhereAs', {
                    relay: daemonRelayHost ?? t('server.relayDrift.statusUnknown'),
                    account: daemonFacts.accountLabel,
                })
                : t('server.relayDrift.connectedElsewhere', { relay: daemonRelayHost ?? t('server.relayDrift.statusUnknown') });
            break;
        case 'daemon_account_mismatch':
            // This service IS signed in — as somebody else — so "needs to sign in" would be
            // untrue. Both accounts are named, so the consequence of connecting is visible.
            title = t('server.relayDrift.bannerAccountMismatchTitle');
            description = t('server.relayDrift.bannerAccountMismatchDescription', {
                relay: daemonRelayHost ?? appRelayHost,
                account: daemonFacts.accountLabel ?? t('server.relayDrift.statusUnknown'),
                appAccount: daemonFacts.appAccountId ? resolveAppAccountLabel(daemonFacts.appAccountId) : t('server.relayDrift.statusUnknown'),
            });
            break;
        case 'daemon_not_installed':
            title = t('server.relayDrift.bannerNotInstalledTitle');
            description = t('server.relayDrift.bannerNotInstalledDescription', { activeRelayUrl: appRelayHost });
            break;
        case 'daemon_not_running':
            title = t('server.relayDrift.bannerNotRunningTitle');
            description = t('server.relayDrift.bannerNotRunningDescription', { activeRelayUrl: appRelayHost });
            break;
        case 'daemon_needs_auth':
            title = t('server.relayDrift.bannerNeedsAuthTitle');
            description = t('server.relayDrift.bannerNeedsAuthDescription', { activeRelayUrl: appRelayHost });
            break;
        default:
            title = t('server.relayDrift.bannerNotConfiguredTitle');
            description = t('server.relayDrift.bannerNotConfiguredDescription', { activeRelayUrl: appRelayHost });
            break;
    }

    return {
        status: classification.status,
        title,
        description,
        actionLabel: t('server.relayDrift.connectHereAction'),
        daemonRelayUrl: classification.status === 'daemon_url_mismatch' ? daemonRelayUrl : null,
    } satisfies RelayDriftSummary;
}

function resolveSameOriginLocalRelayUrl(activeServerUrl: string): string | null {
    const appSameOriginRelayUrl = getWebSameOriginServerUrl();
    if (!appSameOriginRelayUrl) {
        return null;
    }
    if (createRelayUrlComparableKeySafe(appSameOriginRelayUrl) === createRelayUrlComparableKeySafe(activeServerUrl)) {
        return null;
    }
    return appSameOriginRelayUrl;
}

function readActiveLocalRelayUrl(snapshot: Readonly<{ activeLocalRelayUrl?: string | null }>): string | null {
    return typeof snapshot.activeLocalRelayUrl === 'string' && snapshot.activeLocalRelayUrl.trim().length > 0
        ? snapshot.activeLocalRelayUrl.trim()
        : null;
}

/** Desktop: this computer's own ambient inspection. Subscribes to nothing else. */
function useThisComputerDriftSummary(): RelayDriftSummary | null {
    const { serverUrl, activeLocalRelayUrl } = getActiveServerSnapshot();
    const { inspection } = useDesktopLocalInspection(true);
    // The account the app is on, read from the same owner the executor spec is built from, and
    // what the daemon's own validated account is compared against (F7).
    const expectedAccountId = getActiveServerAccountScope()?.accountId ?? null;
    return React.useMemo(() => {
        const localRelayUrl = readActiveLocalRelayUrl({ activeLocalRelayUrl }) ?? resolveSameOriginLocalRelayUrl(serverUrl);
        return describeRelayDrift(
            daemonFactsFromLocalInspection(inspection, { relayUrl: serverUrl, localRelayUrl, accountId: expectedAccountId }),
            serverUrl,
            localRelayUrl,
        );
    }, [activeLocalRelayUrl, expectedAccountId, inspection, serverUrl]);
}

/** Web and phone: the primary machine's cached doctor snapshot (SB2) — another machine's daemon. */
function useRemoteMachineDriftSummary(): RelayDriftSummary | null {
    const primaryMachineId = usePrimaryMachineFromActiveSelection();
    const { serverId, serverUrl, activeLocalRelayUrl } = getActiveServerSnapshot();
    const cachedDoctorSnapshot = React.useMemo(() => {
        if (!primaryMachineId || !serverId) {
            return null;
        }
        return readCachedMachineDoctorSnapshot({ serverId, machineId: primaryMachineId });
    }, [primaryMachineId, serverId]);
    return React.useMemo(() => describeRelayDrift(
        daemonFactsFromDoctorSnapshot(cachedDoctorSnapshot),
        serverUrl,
        readActiveLocalRelayUrl({ activeLocalRelayUrl })
            ?? resolveDoctorLocalRelayCandidate({ activeRelayUrl: serverUrl, doctorSnapshot: cachedDoctorSnapshot })
            ?? resolveSameOriginLocalRelayUrl(serverUrl),
    ), [activeLocalRelayUrl, cachedDoctorSnapshot, serverUrl]);
}

/**
 * U7 — the ONE projection of what this computer's daemon is doing relative to the app: which relay
 * and account it is connected to, and whether that contradicts the app. Every surface that
 * describes this computer reads it — Settings › Machines, Settings › This computer, the sessions
 * empty state, the sidebar status and the tray — so they cannot tell four different stories.
 *
 * It is the summary: classification and copy only, no task, no prompt handling, no callbacks, so
 * always-mounted chrome (the tray) can hold it without mounting setup machinery
 * (`apps/ui/AGENTS.md`). `useRelayDriftBanner` adds the one repair action on top of it. On desktop
 * it reads only this computer's inspection — never the account's machine list.
 *
 * `null` means aligned, or no daemon knowledge at all (R10).
 */
export function useRelayDriftSummary(): RelayDriftSummary | null {
    // `isTauriDesktop()` is fixed for the life of the process, so exactly one of these runs in any
    // given app and the hook order never changes between renders.
    return isTauriDesktop() ? useThisComputerDriftSummary() : useRemoteMachineDriftSummary();
}
