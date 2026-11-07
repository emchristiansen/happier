import {
    daemonRelayMatchesExpectation,
    resolveThisComputerService,
    type DesktopBackgroundServiceAutostartMode,
    type DesktopLocalInspection,
    type DesktopSetupExpectation,
} from '@/setup/deriveDesktopLocalSetupSnapshot';
import { readDisplayMachineIdForSession } from '@/sync/ops/sessionMachineTarget';
import type { Session } from '@/sync/domains/state/storageTypes';
import { isSessionActive } from '@/utils/sessions/sessionUtils';

/**
 * What the desktop app does with the background service as it quits.
 *
 * With login start off, the deal the settings toggle makes with the user is explicit: this
 * computer answers while the app is open and stops answering once it is closed. Honouring that
 * must never cost anyone their work, so an active agent session turns the decision into a question
 * rather than an action.
 *
 * Paths that cannot ask — force quit, OS shutdown, logout — are not an input here and never reach
 * this function: they deliver no exit handoff at all, or deliver one the app is killed before
 * answering. Nothing stops the service without an answer, so those paths leave it running.
 */
/**
 * `ask` — agent sessions are running here. `askUnknown` — the app cannot see this daemon's
 * sessions at all (another account, or signed out), so it asks without claiming any are running
 * (U11). `keepInMenuBar` — R16 (a): the services start at login, so quitting releases the window
 * and the web UI and keeps the tray, with the services running. `leaveRunning` — quit outright and
 * touch nothing (the mode is unknown).
 */
export type DesktopCloseDaemonDecision = 'stop' | 'ask' | 'askUnknown' | 'leaveRunning' | 'keepInMenuBar';

/**
 * Which Quit was chosen: "Quit Happier" follows the login-start setting; "Stop background
 * services and quit" (the tray's second Quit) stops them whatever it says.
 */
export type DesktopQuitIntent = 'quit' | 'stopServices';

export function resolveDesktopCloseDaemonDecision(input: Readonly<{
    intent?: DesktopQuitIntent;
    /**
     * The installed service's autostart mode, as the CLI reports it. `null` means the CLI that
     * answered proved no mode — unknown, never `on-demand`.
     */
    autostart: DesktopBackgroundServiceAutostartMode | null;
    /** Agent sessions running on THIS computer — the only ones stopping this daemon would end. */
    activeLocalSessionCount: number;
    /**
     * Whether the count above could describe this daemon at all: the app's session snapshot has
     * loaded, the service owns the reachable daemon with the inspected machine id, the daemon is
     * on the app's active relay, and that relay validated its credentials for the app's account.
     * Otherwise zero sessions may only mean they are unseen.
     */
    canSeeDaemonSessions: boolean;
}>): DesktopCloseDaemonDecision {
    const stopRequested = input.intent === 'stopServices' || input.autostart === 'on-demand';
    if (!stopRequested) {
        // The service is meant to outlive the app, or nothing proved otherwise. Quitting the app
        // is not a reason to take the computer off the air on a guess. When it is meant to outlive
        // it, the tray outlives it too, so this computer stays one click from its services.
        return input.autostart === 'at-login' ? 'keepInMenuBar' : 'leaveRunning';
    }
    if (!input.canSeeDaemonSessions) {
        // Zero-because-invisible is not "nothing to lose", so it is put to the user rather than
        // decided for them — without claiming sessions it never saw.
        return 'askUnknown';
    }
    if (input.activeLocalSessionCount > 0) {
        return 'ask';
    }
    return 'stop';
}

/**
 * How much is at stake if this computer's daemon stops: the agent sessions running **here**.
 *
 * Both halves come from their canonical owners — `isSessionActive` for liveness and
 * `readDisplayMachineIdForSession` for which computer a session is on — so this never becomes a
 * second notion of an active session. Sessions on other machines are untouched by stopping this
 * daemon and are not counted.
 */
export function countActiveLocalAgentSessions(params: Readonly<{
    sessions: readonly Session[] | null;
    machineId: string | null;
}>): number {
    if (!params.machineId || !params.sessions) {
        return 0;
    }
    return params.sessions.filter((session) => isSessionActive(session)
        && readDisplayMachineIdForSession({ sessionId: session.id, metadata: session.metadata ?? null }) === params.machineId
    ).length;
}

/**
 * The machine whose agent sessions the app can actually see on this computer: the daemon serving
 * the app's relay, when its service owns the reachable daemon with the inspected machine id, on the
 * app's relay, validated for the app's account. `null` when the app cannot see them — zero sessions
 * there would only mean unseen. The quit question and the tray's session count read this one rule.
 */
export function resolveVisibleSessionMachineId(params: Readonly<{
    inspection: DesktopLocalInspection;
    appRelay: DesktopSetupExpectation;
}>): string | null {
    if (params.inspection.status !== 'resolved' || !params.appRelay.accountId) {
        return null;
    }
    const facts = resolveThisComputerService(params.inspection, params.appRelay)?.facts ?? null;
    const convergence = facts?.runtimeConvergence;
    if (!facts || !facts.auth.machineId || !convergence) {
        return null;
    }
    const visible = facts.auth.validatedAccountId === params.appRelay.accountId
        && convergence.controlReachable
        && convergence.serviceOwnsRunningDaemon
        && convergence.machineIdMatches
        && daemonRelayMatchesExpectation(facts, params.appRelay);
    return visible ? facts.auth.machineId : null;
}
