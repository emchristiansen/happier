import type { SetupServiceConsentPrompt } from '@/components/systemTasks/useThisComputerSetupTask';
import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * The focused alert for the executor's service-ownership decision (UD5 / plan L5). The facts are
 * the CLI's (`service install --dry-run --json`, INV9); this only presents them and returns the
 * answer. Nothing here re-evaluates ownership.
 *
 * Two different questions arrive here. A conflict with a service that exists is "replace it?".
 * A daemon someone started by hand, with no service at all, is "let the app take it over?" — and
 * saying a background service already exists there would be untrue (U8), so it gets its own title
 * and the CLI's own takeover notice.
 */
export async function presentSetupServiceConsent(prompt: SetupServiceConsentPrompt): Promise<boolean> {
    const services = [...prompt.competingServices, ...prompt.servicesToRemove];
    if (prompt.message == null && services.length === 0 && prompt.takeover != null) {
        return await Modal.confirm(
            t('setupSurface.consentTakeoverTitle'),
            prompt.takeover,
            { confirmText: t('setupSurface.consentTakeoverConfirm'), cancelText: t('setupSurface.relayMoveKeep') },
        );
    }
    const detail = prompt.message ?? prompt.takeover ?? t('setupSurface.consentBodyFallback');
    const body = services.length > 0
        ? `${detail}\n\n${t('setupSurface.consentServicesList', { services: services.join(', ') })}`
        : detail;
    return await Modal.confirm(
        t('setupSurface.consentTitle'),
        body,
        { confirmText: t('setupSurface.consentConfirm'), cancelText: t('setupSurface.consentKeep') },
    );
}
