import * as React from 'react';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { useUpdates } from '@/hooks/inbox/useUpdates';
import { UPDATES_ROUTE } from '@/components/updates/updatesRoute';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

function toErrorMessage(error: unknown): string | null {
    if (error instanceof Error) {
        const message = error.message.trim();
        return message || null;
    }

    if (typeof error === 'string') {
        const message = error.trim();
        return message || null;
    }

    return null;
}

function formatLastChecked(value: Date | undefined): string {
    return value instanceof Date ? value.toLocaleString() : t('status.unknown');
}

export const OtaUpdateStatusSection = React.memo(function OtaUpdateStatusSection() {
    const { theme } = useUnistyles();
    const {
        otaUpdatesEnabled,
        isChecking,
        isDownloading,
        isRestarting,
        isUpdatePending,
        downloadProgress,
        checkError,
        downloadError,
        lastCheckForUpdateTimeSinceRestart,
    } = useUpdates();

    const progressPercent = typeof downloadProgress === 'number'
        ? `${Math.max(0, Math.min(100, Math.round(downloadProgress * 100)))}%`
        : null;
    const errorMessage = toErrorMessage(downloadError) ?? toErrorMessage(checkError);

    const otaStatusDetail = (() => {
        if (!otaUpdatesEnabled) return t('systemStatus.updates.disabled');
        if (isRestarting) return t('systemStatus.updates.applying');
        if (isUpdatePending) return t('systemStatus.updates.readyToApply');
        if (isDownloading) {
            return progressPercent
                ? t('systemStatus.updates.downloadingProgress', { progress: progressPercent })
                : t('systemStatus.updates.downloading');
        }
        if (isChecking) return t('systemStatus.updates.checking');
        if (errorMessage) return t('systemStatus.updates.error');
        if (lastCheckForUpdateTimeSinceRestart instanceof Date) return t('systemStatus.updates.upToDate');
        return t('systemStatus.updates.unknown');
    })();

    const otaStatusSubtitle = errorMessage
        ? <Text style={{ color: theme.colors.text.secondary }}>{errorMessage}</Text>
        : undefined;

    const router = useRouter();
    const openUpdates = React.useCallback(() => {
        router.push(UPDATES_ROUTE);
    }, [router]);

    return (
        <ItemGroup title={t('systemStatus.sections.updates')}>
            <Item
                title={t('systemStatus.updates.otaStatus')}
                detail={otaStatusDetail}
                subtitle={otaStatusSubtitle}
                mode="info"
                icon={<Icon name="cloud-arrow-down" size={24} color={theme.colors.accent.blue} />}
            />
            <Item
                title={t('systemStatus.updates.lastChecked')}
                detail={formatLastChecked(lastCheckForUpdateTimeSinceRestart)}
                mode="info"
                icon={<Icon name="clock" size={24} color={theme.colors.accent.orange} />}
            />
            {/* Diagnostics only: the update itself lives in Settings › Updates (one entry, R13 (e)). */}
            <Item
                testID="system-status-open-updates"
                title={t('updates.action.openUpdates')}
                onPress={openUpdates}
                icon={<Icon name="hard-drive-download" size={24} color={theme.colors.accent.indigo} />}
            />
        </ItemGroup>
    );
});
