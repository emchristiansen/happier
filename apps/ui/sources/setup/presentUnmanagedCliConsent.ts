import type { SetupUnmanagedCliDecision } from '@/auth/terminal/approveSetupPairingForTarget';
import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * The one ask before this app releases the account content key to a command line its own install
 * path did not place — a repo checkout, an env override, or a binary someone dropped into the
 * managed directory without installing it.
 *
 * The desktop-managed case never reaches here: it is approved silently, so ordinary first-run
 * onboarding stays zero-interaction. What arrives here would otherwise have been a dead end — the
 * setup task could only fail `pairing_declined` and offer a Retry that failed identically forever,
 * which locked out every developer and fork running a CLI they built themselves.
 *
 * The question names the resolved binary because that is the fact the person can actually judge.
 * It is the same decision they already make, attended, when they pair a terminal by QR code
 * (`useConnectTerminal`); the marker this app reads is an install-ownership record, not a proof of
 * publisher identity, so a human — not a plain text file — is the right authority for the
 * unattended case it does not cover.
 */
export async function presentUnmanagedCliConsent(decision: SetupUnmanagedCliDecision): Promise<boolean> {
    return await Modal.confirm(
        t('setupSurface.cliTrustTitle'),
        decision.cliCommand
            ? t('setupSurface.cliTrustBody', { command: decision.cliCommand })
            : t('setupSurface.cliTrustBodyUnknownCommand'),
        { confirmText: t('setupSurface.cliTrustApprove'), cancelText: t('common.cancel') },
    );
}
