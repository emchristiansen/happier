import { getStorage } from '@/sync/domains/state/storageStore';
import { applyLocalSettingsFromUi } from '@/sync/store/settingsWriters';

import type { KeptBackgroundServiceIdentity } from './relayReconciliationConsent';

/**
 * UD5's one device-local preference: "always move my default-following background service with my
 * selected default relay". It is stored through the canonical local-settings owner
 * (`LOCAL_SETTING_ARTIFACTS`), so it never syncs to the account and never leaves this device.
 */
export function readAlwaysMoveDefaultFollowingService(): boolean {
    return getStorage().getState().localSettings.desktopAlwaysMoveDefaultFollowingService === true;
}

export function rememberAlwaysMoveDefaultFollowingService(): void {
    applyLocalSettingsFromUi({ desktopAlwaysMoveDefaultFollowingService: true });
}

/**
 * D5 — "Keep it as is", remembered on this device for the daemon it was said about (its relay and
 * account). Same owner, same device-local scope as the preference above: it never syncs, so another
 * computer's choice cannot silence this one. The drift banner stays the way back.
 */
export function readKeptBackgroundService(): KeptBackgroundServiceIdentity | null {
    return getStorage().getState().localSettings.desktopKeptBackgroundService ?? null;
}

export function rememberKeptBackgroundService(identity: KeptBackgroundServiceIdentity): void {
    applyLocalSettingsFromUi({ desktopKeptBackgroundService: { relayKey: identity.relayKey, accountId: identity.accountId } });
}
