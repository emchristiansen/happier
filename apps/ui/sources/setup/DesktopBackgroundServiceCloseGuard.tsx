import * as React from 'react';

import { Modal } from '@/modal';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storageStore';
import { t } from '@/text';
import { invokeTauri, listenTauriEvent } from '@/utils/platform/tauri';

import {
    readManagedLoginStartMode,
    resolveThisComputerService,
    thisComputerAppManagesService,
    type DesktopBackgroundServiceAutostartMode,
    type DesktopLocalInspection,
    type DesktopSetupExpectation,
} from './deriveDesktopLocalSetupSnapshot';
import { stopBackgroundService } from './desktopBackgroundServiceControl';
import { desktopSetupCoordinator } from './desktopSetupCoordinator';
import { presentBackgroundServiceCloseConsent } from './presentBackgroundServiceCloseConsent';
import {
    countActiveLocalAgentSessions,
    resolveDesktopCloseDaemonDecision,
    resolveVisibleSessionMachineId,
    type DesktopQuitIntent,
} from './resolveDesktopCloseDaemonDecision';

/** Emitted by `src-tauri/src/shutdown.rs` once per quit, never per window. */
export const DESKTOP_APP_EXIT_REQUESTED_EVENT = 'desktop_app_exit_requested';

/**
 * The handoff names which Quit was chosen (anything else is the plain "Quit Happier") and the
 * login-start setting as the native side last knew it — `null` when it knows none.
 */
function readQuitRequest(payload: unknown): Readonly<{ intent: DesktopQuitIntent; nativeStartAtLogin: boolean | null }> {
    const record = payload && typeof payload === 'object' ? payload as { stopServices?: unknown; startAtLogin?: unknown } : {};
    return {
        intent: record.stopServices === true ? 'stopServices' : 'quit',
        nativeStartAtLogin: typeof record.startAtLogin === 'boolean' ? record.startAtLogin : null,
    };
}

/**
 * N-2/A14-01 — whether the sessions the app sees are all a stop of every managed service could end:
 * the status producer counts the running managed services here, and the only one may be the daemon
 * whose sessions are visible (the app relay's, when the app manages it). Any other running managed
 * service — a relay's own "Connect … too" one — may have sessions the app never saw; an unknown
 * count covers nothing.
 */
function aggregateStopIsCoveredByVisibleSessions(
    inspection: DesktopLocalInspection,
    appRelay: DesktopSetupExpectation,
    visibleMachineId: string | null,
): boolean {
    if (inspection.status !== 'resolved') return false;
    const running = inspection.runningManagedServiceCount;
    if (typeof running !== 'number') return false;
    const serving = resolveThisComputerService(inspection, appRelay);
    const visibleManagedRunning = visibleMachineId !== null && serving !== null && thisComputerAppManagesService(serving) ? 1 : 0;
    return running <= visibleManagedRunning;
}

/**
 * C8 (c)/N-7 — the login-start setting this quit follows: what this app open read, else what the
 * native side last knew (a quit that beats the first read, or a window rebuilt from menu-bar mode).
 * Either answer is taken: "on" keeps the tray and touches nothing, and "off" owes the stop — which,
 * with nothing read yet, the app cannot see any session of, so it asks before stopping anything.
 */
function resolveQuitAutostart(inspection: DesktopLocalInspection, nativeStartAtLogin: boolean | null): DesktopBackgroundServiceAutostartMode | null {
    if (inspection.status === 'resolved') {
        // A14-02 — read; the managed services' common mode, unknown when they disagree.
        return readManagedLoginStartMode(inspection);
    }
    if (nativeStartAtLogin === null) return null;
    return nativeStartAtLogin ? 'at-login' : 'on-demand';
}

/**
 * C8 (b)/A11-03 — the person asked for the services to stop and they did not: said in the window
 * (shown again, since Quit from the tray leaves it hidden), never swallowed. The app then stays in
 * the tray instead of exiting, so the services it could not stop stay visible and Quit can be tried
 * again from there.
 */
async function presentStopFailure(error: unknown): Promise<void> {
    // The executor's own named reason, the same one the tray's failure notice carries.
    const reason = error instanceof Error ? error.message.trim() : '';
    const body = t('settingsDesktop.closeStopFailedBody');
    await invokeTauri('desktop_show_main_window');
    await Modal.alertAsync(
        t('settingsDesktop.trayActionFailedTitle'),
        reason ? `${body}\n\n${reason}` : body,
        [{ text: t('common.ok'), style: 'cancel' }],
    );
}

/**
 * Honours the background-service preference as the desktop app quits.
 *
 * The native side holds the exit and hands the decision here because only the app knows what is
 * running on this computer and can ask about it. Whatever happens — a failed read, a dismissed
 * question, a thrown anything — the quit finishes, and the daemon is only ever stopped by an answer
 * that was actually reached. The one ending that is not an exit besides R16's tray is a stop that
 * failed: that is said, and the app stays in the tray so it can be tried again. Nothing is retried
 * and nothing is timed: a quit the webview cannot finish is finished by pressing Quit again.
 */
export function DesktopBackgroundServiceCloseGuard(props: Readonly<{ enabled: boolean }>): null {
    const { enabled } = props;
    React.useEffect(() => {
        if (!enabled) {
            return;
        }

        let cancelled = false;
        let dispose: (() => void) | null = null;
        void listenTauriEvent<unknown>(DESKTOP_APP_EXIT_REQUESTED_EVENT, (payload) => {
            void (async () => {
                // R16 (a) — with the services starting at login the app keeps its tray and drops
                // only the window and the web UI; every other ending quits outright.
                let keepInMenuBar = false;
                try {
                    // What this app open has already established — never a new read, and never a
                    // wait on one in flight. Starting a read here would begin a managed-CLI
                    // acquisition while the exit is held, and awaiting the warm-up's read would
                    // hold the exit on that same download; the only bound either way is the user
                    // pressing Quit again. Nothing established yet means nothing to act on.
                    const inspection = desktopSetupCoordinator.readInspectionSnapshot();
                    const appScope = getActiveServerAccountScope();
                    const activeServer = getActiveServerSnapshot();
                    const appRelay = {
                        relayUrl: activeServer.serverUrl,
                        localRelayUrl: activeServer.activeLocalRelayUrl ?? null,
                        accountId: appScope?.accountId ?? null,
                    };
                    // The stop ends every service the app manages (one login-start setting, read
                    // from the default-following service that the toggle writes). The app sees the
                    // sessions of the daemon serving its own relay only, so the sessions question
                    // covers the stop only when that is every service the stop could end (N-2).
                    // The one visibility rule (shared with the tray's count): `null` when the app
                    // cannot see the sessions of the daemon serving its relay — including when that
                    // relay's own service could not be read.
                    const visibleMachineId = resolveVisibleSessionMachineId({ inspection, appRelay });
                    const stopCoveredBySeenSessions = aggregateStopIsCoveredByVisibleSessions(inspection, appRelay, visibleMachineId);
                    const storage = getStorage().getState();
                    const request = readQuitRequest(payload);
                    const autostart = resolveQuitAutostart(inspection, request.nativeStartAtLogin);
                    const decision = resolveDesktopCloseDaemonDecision({
                        intent: request.intent,
                        autostart,
                        activeLocalSessionCount: countActiveLocalAgentSessions({
                            sessions: Object.values(storage.sessions ?? {}),
                            machineId: visibleMachineId,
                        }),
                        canSeeDaemonSessions: storage.isDataReady
                            && stopCoveredBySeenSessions
                            && visibleMachineId !== null,
                    });
                    if (decision === 'keepInMenuBar') {
                        keepInMenuBar = true;
                        return;
                    }
                    if (decision === 'ask' || decision === 'askUnknown') {
                        // Quit from the tray leaves the window hidden, so the question would be
                        // asked of a webview nobody can see: the exit is held, Quit looks like it
                        // did nothing, and the deal the toggle made goes unhonoured.
                        await invokeTauri('desktop_show_main_window');
                        if (await presentBackgroundServiceCloseConsent({ sessions: decision === 'ask' ? 'running' : 'unknown' }) !== 'stop') {
                            // C8 (a) — kept running: with the services starting at login that is
                            // exactly what the tray is kept for, so Quit leaves it (R16 a).
                            keepInMenuBar = autostart === 'at-login';
                            return;
                        }
                    }
                    if (decision !== 'leaveRunning') {
                        try {
                            await stopBackgroundService();
                        } catch (error) {
                            keepInMenuBar = true;
                            await presentStopFailure(error);
                        }
                    }
                } catch {
                    // A read, a question or a notice that failed leaves the background service
                    // exactly where it is: no failure here is worth ending someone's running agent
                    // session, and the quit still finishes below.
                } finally {
                    // The webview is being torn down around this handler, so even finishing the
                    // shutdown can reject; the app still quits either way.
                    void (keepInMenuBar
                        ? invokeTauri('desktop_finish_shutdown', { outcome: 'menuBar' })
                        : invokeTauri('desktop_finish_shutdown')).catch(() => {});
                }
            })();
        }).then(
            (disposeListener) => {
                if (cancelled) {
                    disposeListener();
                    return;
                }
                dispose = disposeListener;
            },
            () => {
                // No exit handoff reaches this app, so there is nothing to guard: the native side
                // finishes the quit on its own and the service is left running.
            },
        );

        return () => {
            cancelled = true;
            dispose?.();
        };
    }, [enabled]);
    return null;
}
