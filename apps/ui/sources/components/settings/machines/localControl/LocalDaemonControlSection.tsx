import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { SystemTaskProgressCard } from '@/components/systemTasks';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useRelayDriftSummary } from '@/components/settings/server/useRelayDriftSummary';
import type { RelayDriftSummary } from '@/components/settings/server/relayDriftTypes';
import { Icon } from '@/components/ui/icons/Icon';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { readKeptCliUpdateCommand, type DesktopLocalReadinessFacts } from '@/setup/deriveDesktopLocalSetupSnapshot';
import { describeThisComputerRelayRow, formatCliChannelLabel, resolveDaemonAccountLabel } from '@/setup/thisComputerLabels';
import type { ThisComputerRelayRow, ThisComputerRelayRows } from '@/setup/thisComputerRelayRows';
import { t } from '@/text';

import { useCliUpdateTask } from './useCliUpdateTask';
import { useLocalDaemonControl } from './useLocalDaemonControl';

/**
 * What Settings › This computer says beside its relay rows, when the rows alone cannot say it: the
 * drift sentence when the daemon contradicts the app — the same words the Machines card, the sessions
 * empty state, the sidebar and the tray use (U7) — else the state of the one list, in the tray's
 * words (R16): still being read, unreadable, not whole, or empty. `null` when the rows say it all.
 */
function resolveRelayListNotice(rows: ThisComputerRelayRows, drift: RelayDriftSummary | null, unavailable: boolean): string | null {
    if (unavailable) return t('settings.systemTaskBridgeUnavailable');
    if (drift) return drift.description;
    switch (rows.status) {
        case 'pending':
            return t('settingsDesktop.trayChecking');
        case 'failed':
            return t('settingsDesktop.trayReadFailed');
        case 'listed':
            if (!rows.complete) return t('settingsDesktop.trayIncomplete');
            return rows.rows.length === 0 ? t('machine.thisComputer.notSetUp') : null;
    }
}

/**
 * R17 — which command line answers for this computer. A CLI the app placed is named by version;
 * one it did not place is named by where it came from, and is never offered an update the app
 * would refuse to make.
 */
function resolveCliSubtitle(facts: DesktopLocalReadinessFacts): string {
    // R12 — once this computer answered who manages the command line, the row says that answer.
    if (facts.cliChoice.mode === 'own' && facts.acquisition.provenance !== 'managed') {
        return t('machine.thisComputer.cliChoiceOwn', { path: facts.acquisition.command });
    }
    if (facts.cliChoice.mode === 'managed' && facts.acquisition.provenance === 'managed') {
        return t('machine.thisComputer.cliChoiceManaged');
    }
    const version = facts.acquisition.version ?? facts.cliUpdate?.currentVersion ?? null;
    if (facts.acquisition.provenance !== 'managed' || facts.cliUpdate?.managed === false) {
        return version
            ? t('machine.thisComputer.cliFromPath', { version, path: facts.acquisition.command })
            : facts.acquisition.command;
    }
    if (!version) {
        return t('machine.thisComputer.cliManagedUnknownVersion');
    }
    // RV-9 — an app of another channel adopts the default channel's CLI (D2), so the channel is
    // what explains which release answers here.
    return facts.acquisition.channel
        ? t('machine.thisComputer.cliManagedOnChannel', { channel: formatCliChannelLabel(facts.acquisition.channel), version })
        : t('machine.thisComputer.cliManaged', { version });
}

/** The version beside the R12 answer, so "Managed by Happier" still says which release answers. */
function resolveCliDetail(facts: DesktopLocalReadinessFacts): string | undefined {
    return facts.cliChoice.mode !== null ? facts.acquisition.version ?? undefined : undefined;
}

/**
 * R12 — the copy of `happier` still installed beside the managed one, whether or not the managed
 * shim was already first on PATH and a choice was unnecessary. Its removal command is shown and
 * copyable, never run: it belongs to the package manager.
 */
function resolveOldCliCopy(facts: DesktopLocalReadinessFacts | null): Readonly<{ subtitle: string; removalCommand: string | null }> | null {
    const other = facts?.acquisition.provenance === 'managed' ? facts.cliChoice.otherCli : null;
    if (!other) return null;
    return {
        subtitle: other.removalCommand
            ? t('machine.thisComputer.cliOldCopyRemove', { path: other.command, command: other.removalCommand })
            : t('machine.thisComputer.cliOldCopyPath', { path: other.command }),
        removalCommand: other.removalCommand,
    };
}

/**
 * A11-08/R12 — the command line the person kept has a newer release: the app never replaces it, so
 * the row names the exact command that does, copyable, never run.
 */
function resolveKeptCliUpdate(facts: DesktopLocalReadinessFacts | null): Readonly<{ subtitle: string; command: string }> | null {
    const command = facts ? readKeptCliUpdateCommand(facts) : null;
    const latestVersion = facts?.cliUpdate?.updateAvailable === true ? facts.cliUpdate.latestVersion : null;
    if (!command || !latestVersion) return null;
    return { subtitle: t('machine.thisComputer.updateCliKept', { version: latestVersion, command }), command };
}

function canUpdateCli(facts: DesktopLocalReadinessFacts | null): facts is DesktopLocalReadinessFacts & { cliUpdate: NonNullable<DesktopLocalReadinessFacts['cliUpdate']> } {
    return facts?.acquisition.provenance === 'managed'
        && facts.cliUpdate?.managed === true
        && facts.cliUpdate.updateAvailable === true;
}

/** The relay's state as a glance: the connection chip's own status colors (the words carry the meaning). */
function relayStateDotColor(theme: ReturnType<typeof useUnistyles>['theme'], state: ThisComputerRelayRow['state']): string {
    switch (state) {
        case 'connected':
            return theme.colors.status.connected;
        case 'offline':
            return theme.colors.status.disconnected;
        default:
            return theme.colors.status.actionRequired;
    }
}

/**
 * One relay this computer has a service for, read the way the connection popover reads it
 * (`describeThisComputerRelayRow`): the relay, and how this computer stands there. The account it
 * answers as is named on the app's own relay; a service set up outside Happier says so (H2).
 */
const ThisComputerRelayItem = React.memo(function ThisComputerRelayItem(props: Readonly<{
    row: ThisComputerRelayRow;
    account: string | null;
}>) {
    const { theme } = useUnistyles();
    const text = describeThisComputerRelayRow(props.row);
    const subtitle = props.account
        ? t('machine.thisComputer.relayAccount', { account: props.account })
        : props.row.appManaged ? undefined : t('settingsDesktop.trayUserOwned');
    return (
        <Item
            testID="settings.localDaemonControl.relay"
            title={text.title}
            subtitle={subtitle}
            detail={text.state}
            leftElement={<StatusDot color={relayStateDotColor(theme, props.row.state)} size={8} />}
            accessibilityLabel={subtitle ? `${text.accessibilityLabel}, ${subtitle}` : text.accessibilityLabel}
            showChevron={false}
            mode="info"
        />
    );
});

function RelayNoticeIcon(): React.ReactElement {
    const { theme } = useUnistyles();
    return <Icon name="info" size={20} color={theme.colors.text.secondary} />;
}

export const LocalDaemonControlSection = React.memo(function LocalDaemonControlSection(props: Readonly<{
    runner?: SystemTaskRunner;
}>) {
    const {
        activeTaskSnapshot,
        activeTaskTitle,
        canRepair,
        canStart,
        cancel,
        changeCommandLine,
        lastErrorMessage,
        repairBackgroundService,
        startDaemonService,
        facts,
        cliFacts,
        relayRows,
        isBusy,
        isUnavailable,
        refreshStatus,
    } = useLocalDaemonControl({
        ...(props.runner ? { runner: props.runner } : {}),
    });
    const drift = useRelayDriftSummary();
    const cliUpdate = useCliUpdateTask(props.runner ? { runner: props.runner } : {});
    const oldCliCopy = resolveOldCliCopy(cliFacts);
    const keptCliUpdate = resolveKeptCliUpdate(cliFacts);
    const relayNotice = resolveRelayListNotice(relayRows, drift, isUnavailable);
    const appRelayAccount = facts ? resolveDaemonAccountLabel(facts.auth) : null;
    // There is a choice to change only when another command line exists beside the managed one.
    const canChangeCli = cliFacts?.cliChoice.otherCli != null;

    return (
        <>
            <ItemGroup title={t('settings.servers')}>
                {relayRows.status === 'listed' && !isUnavailable ? relayRows.rows.map((row) => (
                    <ThisComputerRelayItem
                        key={row.relayUrl}
                        row={row}
                        account={row.appRelay ? appRelayAccount : null}
                    />
                )) : null}
                {relayNotice ? (
                    <Item
                        testID="settings.localDaemonControl.status"
                        title={t('machine.status')}
                        subtitle={relayNotice}
                        subtitleLines={0}
                        leftElement={<RelayNoticeIcon />}
                        loading={relayRows.status === 'pending' && !isUnavailable}
                        showChevron={false}
                        mode="info"
                    />
                ) : null}
            </ItemGroup>
            <ItemGroup title={t('machine.daemon')}>
                {facts?.auth.machineId ? (
                    <Item
                        testID="settings.localDaemonControl.machineId"
                        title={t('machine.machineId')}
                        subtitle={facts.auth.machineId}
                        showChevron={false}
                        mode="info"
                    />
                ) : null}
                {cliFacts ? (
                    <Item
                        testID="settings.localDaemonControl.cli"
                        title={t('machine.thisComputer.cliTitle')}
                        subtitle={resolveCliSubtitle(cliFacts)}
                        detail={resolveCliDetail(cliFacts)}
                        showChevron={false}
                        mode="info"
                    />
                ) : null}
                {oldCliCopy ? (
                    <Item
                        testID="settings.localDaemonControl.oldCli"
                        title={t('machine.thisComputer.cliOldCopyTitle')}
                        subtitle={oldCliCopy.subtitle}
                        {...(oldCliCopy.removalCommand ? { copy: oldCliCopy.removalCommand } : {})}
                        showChevron={false}
                        mode={oldCliCopy.removalCommand ? 'interactive' : 'info'}
                    />
                ) : null}
                {canChangeCli ? (
                    <Item
                        testID="settings.localDaemonControl.changeCli"
                        title={t('machine.thisComputer.cliChoiceChange')}
                        onPress={() => {
                            void changeCommandLine();
                        }}
                        disabled={!canRepair || cliUpdate.running}
                    />
                ) : null}
                {keptCliUpdate ? (
                    <Item
                        testID="settings.localDaemonControl.updateKeptCli"
                        title={t('machine.thisComputer.updateCliTitle')}
                        subtitle={keptCliUpdate.subtitle}
                        subtitleLines={0}
                        copy={keptCliUpdate.command}
                        showChevron={false}
                    />
                ) : null}
                {canUpdateCli(cliFacts) ? (
                    <Item
                        testID="settings.localDaemonControl.updateCli"
                        title={t('machine.thisComputer.updateCliTitle')}
                        subtitle={cliUpdate.errorMessage ?? (cliFacts.cliUpdate.latestVersion
                            ? t('machine.thisComputer.updateCliAvailable', { version: cliFacts.cliUpdate.latestVersion })
                            : undefined)}
                        onPress={() => {
                            void cliUpdate.start();
                        }}
                        loading={cliUpdate.running}
                        disabled={isUnavailable || isBusy || cliUpdate.running}
                    />
                ) : null}
                <Item
                    testID="settings.localDaemonControl.start"
                    title={t('sessionGettingStarted.title.startDaemon')}
                    onPress={() => {
                        void startDaemonService();
                    }}
                    disabled={!canStart}
                />
                {/* One way to connect this computer here, named for what it does (U15). */}
                <Item
                    testID="settings.localDaemonControl.repair"
                    title={drift ? drift.actionLabel : t('server.relayDrift.repairAction')}
                    onPress={() => {
                        void repairBackgroundService();
                    }}
                    disabled={!canRepair || cliUpdate.running}
                />
                <Item
                    testID="settings.localDaemonControl.refresh"
                    title={t('common.refresh')}
                    onPress={refreshStatus}
                    disabled={isBusy || isUnavailable}
                />
                {lastErrorMessage ? (
                    <Item
                        title={t('common.error')}
                        subtitle={lastErrorMessage}
                        showChevron={false}
                        mode="info"
                    />
                ) : null}
            </ItemGroup>
            {activeTaskSnapshot ? (
                <SystemTaskProgressCard
                    title={activeTaskTitle ?? t('machine.daemon')}
                    snapshot={activeTaskSnapshot}
                    onCancel={cancel}
                />
            ) : null}
            {cliUpdate.snapshot && cliUpdate.running ? (
                <SystemTaskProgressCard
                    title={t('machine.thisComputer.updatingCli')}
                    snapshot={cliUpdate.snapshot}
                />
            ) : null}
        </>
    );
});
