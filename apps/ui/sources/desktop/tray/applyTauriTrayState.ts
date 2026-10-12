import { invokeTauri } from '@/utils/platform/tauri';

import type { DesktopTrayState } from './buildDesktopTrayState';

/**
 * What a tray item asked for while the main window was being built again (menu-bar mode): a screen,
 * or — D11-3 — a relay row's Open, which is the person picking that relay.
 */
export type DesktopTrayDestination = 'updates' | 'settings' | Readonly<{ relayUrl: string }>;

/** The native side's name for a relay row's Open (`"relay:<relayUrl>"`, W11-NATIVE contract). */
const RELAY_DESTINATION_PREFIX = 'relay:';

/**
 * Pushes the tray's facts to the native menu. Resolves what a tray item asked for while this window
 * was being created, exactly once, so the fresh web UI can act on it after its listeners exist.
 */
export async function applyTauriTrayState(state: DesktopTrayState): Promise<DesktopTrayDestination | null> {
    const destination = await invokeTauri<string | null>('desktop_set_tray_state', { state });
    if (destination === 'updates' || destination === 'settings') return destination;
    if (typeof destination === 'string' && destination.startsWith(RELAY_DESTINATION_PREFIX)) {
        const relayUrl = destination.slice(RELAY_DESTINATION_PREFIX.length).trim();
        return relayUrl ? { relayUrl } : null;
    }
    return null;
}
