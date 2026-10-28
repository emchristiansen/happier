import type { SetupCliChoice, SetupCliChoicePromptPayload } from '@happier-dev/protocol';

import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * R12's one question, asked when setup finds a `happier` this app did not install: let Happier
 * manage the command line (install its own, put it first on PATH, move the background service to
 * it) or keep the person's own. It names the version and the path, because those are what the
 * person recognises. `null` means the alert was dismissed without an answer: nothing is recorded
 * and the run stops before it writes anything.
 */
export async function presentCliChoice(prompt: SetupCliChoicePromptPayload): Promise<SetupCliChoice | null> {
    let answer: SetupCliChoice | null = null;
    // A kept CLI that disappeared (R13 b) is asked about by the path it was at, as missing.
    const title = prompt.missing
        ? t('setupSurface.cliChoiceTitleMissing')
        : prompt.version
            ? t('setupSurface.cliChoiceTitle', { version: prompt.version })
            : t('setupSurface.cliChoiceTitleUnknownVersion');
    // RV3-1: when a managed `happier` Happier did not add (the installer's link) answers first in new
    // terminals, keeping this one could not make the terminal run it, so Keep is not offered; the
    // body names what would have to go first. "Not now" answers nothing, like a dismissal.
    const keepBlockedBy = prompt.keepBlockedBy;
    const body = keepBlockedBy
        ? t('setupSurface.cliChoiceBodyKeepBlocked', { path: prompt.command, link: keepBlockedBy })
        : prompt.missing
            ? t('setupSurface.cliChoiceBodyMissing', { path: prompt.command })
            : prompt.belowSetupFloor
                ? t('setupSurface.cliChoiceBodyOutdated', { path: prompt.command })
                : t('setupSurface.cliChoiceBody', { path: prompt.command });
    await Modal.alertAsync(
        title,
        body,
        [
            keepBlockedBy
                ? { text: t('setupSurface.cliChoiceNotNow'), style: 'cancel' }
                : { text: t('setupSurface.cliChoiceKeep'), style: 'cancel', onPress: () => { answer = 'own'; } },
            { text: t('setupSurface.cliChoiceManage'), onPress: () => { answer = 'managed'; } },
        ],
    );
    return answer;
}
