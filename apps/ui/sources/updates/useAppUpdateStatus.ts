import * as React from 'react';
import { Linking, Platform } from 'react-native';

import { desktopUpdater } from '@/desktop/updates/desktopUpdater';
import { useDesktopUpdater } from '@/desktop/updates/useDesktopUpdater';
import { useUpdates } from '@/hooks/inbox/useUpdates';
import { useNativeUpdateStatus } from '@/hooks/ui/useNativeUpdate';
import { t } from '@/text';
import { isTauriDesktop } from '@/utils/platform/tauri';

import { buildAppUpdateItem, type AppUpdateItemModel } from './items/buildAppUpdateItem';
import { useWebUiDeploymentFreshness } from './useWebUiDeploymentFreshness';

export type AppUpdateStatus = Readonly<{
    model: AppUpdateItemModel;
    /** When the app's last successful check settled (ms); `null` when it has none to report. */
    checkedAt: number | null;
    /** Runs the row's action: Update (download), Restart to update, Retry, Reload, open the store. */
    run: () => Promise<void>;
    /** The explicit "Check for updates". */
    checkNow: () => Promise<void>;
    /** "Skip this version" — the desktop app only; keyed to the offered version. */
    skipVersion: (() => void) | null;
}>;

/**
 * The "This app" producer (R13 (e)): one classification (`buildAppUpdateItem`) over the app's
 * update owners, each of which is a shared single-flight store — mounting this in several surfaces
 * never starts a second check.
 */
export function useAppUpdateStatus(): AppUpdateStatus {
    const nativeUpdateStatus = useNativeUpdateStatus();
    const nativeUpdateUrl = nativeUpdateStatus?.updateUrl ?? null;
    const nativeRequired = nativeUpdateStatus?.required === true;
    const desktop = useDesktopUpdater();
    const ota = useUpdates();
    const webUi = useWebUiDeploymentFreshness();
    const otaDownloadProgress = typeof ota.downloadProgress === 'number' ? ota.downloadProgress : null;

    const model = React.useMemo(() => buildAppUpdateItem({
        platformOs: Platform.OS,
        desktopHost: isTauriDesktop(),
        title: t('updates.thisAppTitle'),
        native: { updateUrl: nativeUpdateUrl, required: nativeRequired },
        webUiUpdateAvailable: webUi.updateAvailable,
        desktop,
        ota: {
            isDownloading: ota.isDownloading === true,
            downloadProgress: otaDownloadProgress,
            isUpdatePending: ota.isUpdatePending === true,
        },
    }), [desktop, nativeRequired, nativeUpdateUrl, ota.isDownloading, ota.isUpdatePending, otaDownloadProgress, webUi.updateAvailable]);

    const reloadOta = ota.reloadApp;
    const checkOta = ota.checkForUpdates;
    const reloadWeb = webUi.reload;
    const run = React.useCallback(async () => {
        const { channel, item } = model;
        if (item.action.kind !== 'run') return;
        switch (channel) {
            case 'native-store': {
                if (!nativeUpdateUrl) return;
                if (await Linking.canOpenURL(nativeUpdateUrl)) await Linking.openURL(nativeUpdateUrl);
                return;
            }
            case 'web-ui':
                reloadWeb();
                return;
            case 'ota':
                await reloadOta();
                return;
            case 'desktop':
                if (item.action.verb === 'restart') return desktopUpdater.install();
                if (item.action.verb === 'retry') return desktopUpdater.retry();
                return desktopUpdater.download();
            case 'none':
                return;
        }
    }, [model, nativeUpdateUrl, reloadOta, reloadWeb]);

    const checkNow = React.useCallback(async () => {
        await Promise.all([desktopUpdater.check({ force: true }), checkOta()]);
    }, [checkOta]);

    const skippable = model.channel === 'desktop' && model.item.state === 'available' && !model.item.skipped;
    return React.useMemo(() => ({
        model,
        checkedAt: desktop.checkedAt,
        run,
        checkNow,
        skipVersion: skippable ? desktopUpdater.skipVersion : null,
    }), [checkNow, desktop.checkedAt, model, run, skippable]);
}
