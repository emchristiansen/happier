import { getDisplayName } from '@/sync/domains/profiles/profile';
import { t } from '@/text';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';

import type { DesktopCliChannel, ThisComputerRelayState } from './deriveDesktopLocalSetupSnapshot';

/**
 * The short form of an account id, for when nothing more readable is known (K1). Long enough to
 * tell two accounts apart at a glance, short enough to sit inside a sentence.
 */
export function formatShortAccountId(accountId: string): string {
    const id = accountId.trim();
    // Shortened in the MIDDLE: the label often ends a sentence ("… as cmuijuzr…."), and a trailing
    // ellipsis followed by that sentence's period read as a typo in every locale.
    return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

/**
 * The account this computer's daemon is signed in as, the way a person reads it: the label the
 * relay's profile gave the CLI (`auth.accountLabel`), else a short id. `null` when the relay
 * validated no account at all.
 */
export function resolveDaemonAccountLabel(auth: Readonly<{ accountLabel: string | null; validatedAccountId: string | null }>): string | null {
    if (auth.accountLabel) return auth.accountLabel;
    return auth.validatedAccountId ? formatShortAccountId(auth.validatedAccountId) : null;
}

/**
 * The account the app is signed in as, labelled the same way as the daemon's so the two read as
 * comparable: the profile's username, else its display name, else a short id. Only the app's own
 * signed-in profile is known here, so any other account id falls back to the short form.
 */
export function resolveAppAccountLabel(accountId: string): string {
    const profile = readRegisteredStorageState()?.profile ?? null;
    if (profile && profile.id === accountId) {
        const label = profile.username ?? getDisplayName(profile);
        if (label) return label;
    }
    return formatShortAccountId(accountId);
}

/**
 * A release channel the way a person reads it ("Stable", "Preview", "Dev"): the channel of the
 * command line this computer runs, which an app of another channel may have adopted (D2).
 */
export function formatCliChannelLabel(channel: DesktopCliChannel): string {
    switch (channel) {
        case 'stable':
            return t('machine.thisComputer.cliChannelStable');
        case 'preview':
            return t('machine.thisComputer.cliChannelPreview');
        case 'publicdev':
            return t('machine.thisComputer.cliChannelDev');
    }
}

/**
 * M4 — what one of this computer's relay rows says, in its two lines and its one spoken sentence:
 * the relay, and how this computer stands there (`listThisComputerRelayRows`). The connection
 * popover and Settings › This computer both read their rows through it, so the same service never
 * reads two ways; the native tray receives the same state words as its labels.
 */
export function describeThisComputerRelayRow(row: Readonly<{ host: string; state: ThisComputerRelayState }>): Readonly<{
    title: string;
    state: string;
    accessibilityLabel: string;
}> {
    switch (row.state) {
        case 'connected':
            return {
                title: row.host,
                state: t('connectionStatus.thisComputerRelayConnected'),
                accessibilityLabel: t('connectionStatus.thisComputerConnectedTo', { relay: row.host }),
            };
        case 'offline': {
            const title = t('connectionStatus.thisComputerSetUpFor', { relay: row.host });
            const state = t('connectionStatus.thisComputerRelayOffline');
            return { title, state, accessibilityLabel: `${title}, ${state}` };
        }
        default: {
            const state = t('connectionStatus.thisComputerRelayNeedsAttention');
            return { title: row.host, state, accessibilityLabel: `${row.host}, ${state}` };
        }
    }
}
