import * as React from 'react';
import type { SystemTaskResult } from '@happier-dev/protocol';

import { getDefaultSystemTaskRunner, useSystemTaskSnapshot } from '@/components/systemTasks';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { isSystemTaskBridgeUnavailableError, readSystemTaskStartErrorMessage } from '@/components/systemTasks/systemTaskStartError';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import { buildLocalDaemonServiceSystemTaskSpec } from './buildLocalDaemonServiceSystemTaskSpec';

type CliPathExposureTaskKind = 'cli.pathExposure.ensure.v1' | 'cli.pathExposure.remove.v1';

function readTaskOutcome(kind: CliPathExposureTaskKind, result: SystemTaskResult | null): string | null {
    if (!result) {
        return null;
    }
    if (!result.ok) {
        const message = typeof result.error?.message === 'string' ? result.error.message.trim() : '';
        return message || t('settings.systemTaskStartFailed');
    }
    const data = (result.data ?? {}) as Record<string, unknown>;
    if (kind === 'cli.pathExposure.remove.v1') {
        return data.removed === true ? t('machine.cliPath.removed') : t('machine.cliPath.nothingToRemove');
    }
    if (data.changed !== true) {
        // Another `happier` already answers in the terminal and was deliberately left in front, so
        // nothing was added; say which one, rather than claiming ours is already there (R17).
        const existingCommand = typeof data.existingCommand === 'string' ? data.existingCommand.trim() : '';
        return existingCommand
            ? t('machine.cliPath.existingCommand', { path: existingCommand })
            : t('machine.cliPath.alreadyPresent');
    }
    return typeof data.shellReloadHint === 'string' && data.shellReloadHint.trim()
        ? data.shellReloadHint.trim()
        : t('machine.cliPath.added');
}

/**
 * Settings repair action for R6/INV5: PATH exposure is ancillary to setup, so when the automatic
 * attempt fails (read-only profile, unsupported environment) the user can retry or undo it here.
 */
export const LocalCliPathExposureSection = React.memo(function LocalCliPathExposureSection(props: Readonly<{
    runner?: SystemTaskRunner;
}>) {
    const runner = props.runner ?? getDefaultSystemTaskRunner();
    const [activeTask, setActiveTask] = React.useState<Readonly<{ kind: CliPathExposureTaskKind; taskId: string }> | null>(null);
    const [startErrorMessage, setStartErrorMessage] = React.useState<string | null>(null);
    const snapshot = useSystemTaskSnapshot(runner, activeTask?.taskId ?? null);
    const isUnavailable = runner.mode === 'unavailable';
    const isBusy = activeTask != null && snapshot?.result == null;

    const startTask = React.useCallback(async (kind: CliPathExposureTaskKind) => {
        if (isUnavailable) {
            return;
        }
        try {
            const taskId = await runner.start(buildLocalDaemonServiceSystemTaskSpec(kind));
            setStartErrorMessage(null);
            setActiveTask({ kind, taskId });
        } catch (error) {
            setActiveTask(null);
            setStartErrorMessage(isSystemTaskBridgeUnavailableError(error)
                ? t('settings.systemTaskBridgeUnavailable')
                : (readSystemTaskStartErrorMessage(error) ?? t('settings.systemTaskStartFailed')));
        }
    }, [isUnavailable, runner]);

    const statusSubtitle = startErrorMessage
        ?? (activeTask ? readTaskOutcome(activeTask.kind, snapshot?.result ?? null) : null);

    return (
        <ItemGroup title={t('machine.cliPath.title')} footer={t('machine.cliPath.footer')}>
            {statusSubtitle ? (
                <Item
                    testID="settings.localCliPath.status"
                    title={t('machine.status')}
                    subtitle={statusSubtitle}
                    showChevron={false}
                    mode="info"
                />
            ) : null}
            <Item
                testID="settings.localCliPath.add"
                title={t('machine.cliPath.addTitle')}
                subtitle={t('machine.cliPath.addSubtitle')}
                onPress={() => {
                    void startTask('cli.pathExposure.ensure.v1');
                }}
                disabled={isUnavailable || isBusy}
            />
            <Item
                testID="settings.localCliPath.remove"
                title={t('machine.cliPath.removeTitle')}
                subtitle={t('machine.cliPath.removeSubtitle')}
                onPress={() => {
                    void startTask('cli.pathExposure.remove.v1');
                }}
                disabled={isUnavailable || isBusy}
            />
        </ItemGroup>
    );
});
