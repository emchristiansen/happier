import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import {
    writeServerSelectionActiveTargetToServer,
    type ServerSelectionActiveTargetWriter,
} from '@/sync/domains/server/selection/serverSelectionActiveTarget';

/**
 * R8/INV7 — the one record of "the user just chose this Relay/Home themselves".
 *
 * Reconciliation must originate from the direct action, not be inferred afterwards from state.
 * The durable selection target cannot carry that meaning: it names the user's *default* relay, so
 * any navigation-, notification-, deep-link-, voice- or focus-driven change that happens to land
 * back on that default looks identical to the user picking it, and repointing the daemon there is
 * a mutation nobody asked for. The direct action records the intent; the authenticated setup gate
 * consumes it exactly once.
 *
 * It is one in-memory slot, valid only within this app run. Nothing establishes a requirement for
 * a relay choice to survive a restart — a choice the user made before quitting is carried by the
 * durable preference, which the gate still reads for *what* relay the app is on, never for *who*
 * moved it — so nothing here is persisted, and there is no expiry, generation or workflow to
 * maintain. A run that ends with an unconsumed intent simply forgets it.
 */
let pendingDirectRelaySelection: string | null = null;

/**
 * F6 — a choice stays the reason for the next relay change only while the app is still on the
 * relay that was chosen. The gate spends it only when the app's relay CHANGED since the last
 * inspection, so a pick that never became such a change (a first-run onboarding pick, a pick of the
 * relay the app was already on, a pick the daemon was already converged for) would otherwise stay
 * armed for the whole run, and an ambient return to that relay later — notification, deep link,
 * voice — would be spent as if the person had just chosen it. Once the app moves to any OTHER relay
 * the choice has been superseded, so it is forgotten there. This watches the active server only
 * while an intent is armed; the pick's own switch lands on the chosen relay and keeps it.
 */
let stopWatchingActiveRelay: (() => void) | null = null;

function clearPendingDirectRelaySelection(): void {
    pendingDirectRelaySelection = null;
    stopWatchingActiveRelay?.();
    stopWatchingActiveRelay = null;
}

function watchActiveRelayWhileArmed(): void {
    if (stopWatchingActiveRelay || pendingDirectRelaySelection === null) return;
    stopWatchingActiveRelay = subscribeActiveServer(() => {
        const pending = pendingDirectRelaySelection;
        if (pending !== null && !areServerProfileIdentifiersEquivalent(pending, getActiveServerSnapshot().serverId)) {
            clearPendingDirectRelaySelection();
        }
    });
}

/**
 * Counts the choices a person has made in this app run, so the gate can notice one it has not
 * acted on yet.
 *
 * The gate reacts to the app's identity changing. A direct pick of the relay the app is ALREADY on
 * changes nothing about that identity — which is exactly the case that matters after an ambient
 * switch moved the app there and the gate refused to repoint the daemon for it. Counting the
 * choices gives that answer a value the gate can subscribe to. Only recording moves it; spending
 * the intent does not, so the gate never reads its own consumption as another answer.
 */
let directRelaySelectionGeneration = 0;
const directRelaySelectionListeners = new Set<() => void>();

export function subscribeDirectRelaySelectionIntent(listener: () => void): () => void {
    directRelaySelectionListeners.add(listener);
    return () => {
        directRelaySelectionListeners.delete(listener);
    };
}

export function readDirectRelaySelectionIntentGeneration(): number {
    return directRelaySelectionGeneration;
}

function normalize(serverIdRaw: string | null | undefined): string | null {
    const serverId = String(serverIdRaw ?? '').trim();
    return serverId.length > 0 ? serverId : null;
}

/**
 * Arms the intent. Only `selectRelayDirectly` below calls it in production (pinned by
 * `setupOwnershipGuards.test.ts`); it stays exported for this module's own contract tests. Only
 * the latest choice is kept: a user who picks again has replaced the question, not queued a
 * second one.
 */
export function recordDirectRelaySelectionIntent(serverId: string): void {
    const next = normalize(serverId);
    if (next === null) {
        clearPendingDirectRelaySelection();
    } else {
        pendingDirectRelaySelection = next;
        watchActiveRelayWhileArmed();
    }
    directRelaySelectionGeneration += 1;
    for (const listener of Array.from(directRelaySelectionListeners)) {
        listener();
    }
}

/**
 * Whether the user directly chose this relay in this app run. Answering `true` spends the intent,
 * so a later ambient return to the same relay cannot replay the mutation. A choice for a different
 * relay is left armed — it has not been acted on yet.
 */
export function consumeDirectRelaySelectionIntent(serverId: string): boolean {
    const requested = normalize(serverId);
    if (pendingDirectRelaySelection === null || requested === null) {
        return false;
    }
    if (!areServerProfileIdentifiersEquivalent(pendingDirectRelaySelection, requested)) {
        return false;
    }
    clearPendingDirectRelaySelection();
    return true;
}

/**
 * The ONE "a person chose this relay for this device" operation (R8/INV7): the connection status
 * control's relay pick, Settings › Server's profile pick, Add and Reset all go through it, so none
 * of them can switch without arming the intent or arm it without switching.
 *
 * The intent is recorded **before** the switch, so it is already armed when the authenticated
 * setup gate re-renders against the new identity — or, for a signed-out relay, when the gate mounts
 * after the sign-in detour. It then writes the durable single-relay selection target and switches
 * this device's active server through the one switch owner.
 *
 * Ambient changes — notification routing, deep-link auto-add, voice, session navigation, restore,
 * group selection — keep calling the raw switch (`activeServerSwitch.ts`) and arm nothing, so the
 * gate never moves the daemon for them.
 */
export async function selectRelayDirectly(params: Readonly<{
    serverId: string;
    selectionTarget: ServerSelectionActiveTargetWriter;
    refreshAuth: (() => Promise<void>) | null;
}>): Promise<boolean> {
    recordDirectRelaySelectionIntent(params.serverId);
    writeServerSelectionActiveTargetToServer(params.selectionTarget, params.serverId);
    return await setActiveServerAndSwitch({
        serverId: params.serverId,
        scope: 'device',
        refreshAuth: params.refreshAuth,
    });
}
