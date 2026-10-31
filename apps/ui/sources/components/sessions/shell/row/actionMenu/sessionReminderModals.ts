import { Modal } from '@/modal';
import type { SessionReminderPresetV1 } from '@/sync/domains/session/organization/sessionReminderPreset';
import { t } from '@/text';

import { SessionReminderDateTimeModal, type SessionReminderDateTimeResult } from './SessionReminderDateTimeModal';
import { SessionReminderPresetManagerModal } from './SessionReminderPresetManagerModal';

export async function showSessionReminderDateTimeModal(nowMs: number): Promise<SessionReminderDateTimeResult | null> {
    return await new Promise((resolve) => {
        Modal.show({
            component: SessionReminderDateTimeModal,
            props: { nowMs, onResolve: resolve },
            onRequestClose: () => resolve(null),
            chrome: {
                kind: 'card',
                title: t('sessionsList.reminders.customTitle'),
                subtitle: t('sessionsList.reminders.customMessage'),
                testID: 'session-reminder-date-time-modal',
                dimensions: { width: 480, maxHeightRatio: 0.86, size: 'md' },
            },
            closeOnBackdrop: true,
        });
    });
}

export async function showSessionReminderPresetManagerModal(
    presets: readonly SessionReminderPresetV1[],
): Promise<SessionReminderPresetV1[] | null> {
    return await new Promise((resolve) => {
        Modal.show({
            component: SessionReminderPresetManagerModal,
            props: { presets, onResolve: resolve },
            onRequestClose: () => resolve(null),
            chrome: {
                kind: 'card',
                title: t('sessionsList.reminders.managePresets'),
                subtitle: t('sessionsList.reminders.managePresetsMessage'),
                testID: 'session-reminder-preset-manager-modal',
                layout: 'fill',
                dimensions: { width: 560, maxHeightRatio: 0.86, size: 'md' },
            },
            closeOnBackdrop: true,
        });
    });
}
