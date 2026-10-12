import { Modal } from '@/modal';
import { t } from '@/text';

/** `stop`: stop the background service anyway. `keep`: leave it running. */
export type BackgroundServiceCloseConsentAnswer = 'stop' | 'keep';

/**
 * The one ask on quit: the user turned login start off, so closing the app should stop the
 * background service — but agent sessions are still running on this computer and stopping it now
 * would end them, or the app cannot see this computer's sessions to know (another account, or
 * signed out), and says exactly that.
 *
 * Cancelling means keep, and so does dismissing: the only answer that ends someone's work is the
 * one they gave on purpose.
 */
export async function presentBackgroundServiceCloseConsent(params: Readonly<{
    /** `running`: sessions were seen on this computer. `unknown`: the app could not see them (U11). */
    sessions: 'running' | 'unknown';
}>): Promise<BackgroundServiceCloseConsentAnswer> {
    let answer: BackgroundServiceCloseConsentAnswer = 'keep';
    await Modal.alertAsync(
        params.sessions === 'running' ? t('settingsDesktop.closeStopTitle') : t('settingsDesktop.closeStopUnknownTitle'),
        params.sessions === 'running' ? t('settingsDesktop.closeStopBody') : t('settingsDesktop.closeStopUnknownBody'),
        [
            { text: t('settingsDesktop.closeStopKeep'), style: 'cancel', onPress: () => { answer = 'keep'; } },
            { text: t('settingsDesktop.closeStopConfirm'), style: 'destructive', onPress: () => { answer = 'stop'; } },
        ],
    );
    return answer;
}
