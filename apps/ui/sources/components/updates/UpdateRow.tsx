import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import type { AgentId } from '@/agents/catalog/catalog';
import { getInstallablesRegistryEntries } from '@/capabilities/installablesRegistry';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ActivitySpinner, ICON_CIRCLE_INK_RATIO, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { StatusTransition } from '@/components/ui/motion/StatusTransition';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ITEM_ROW_PADDING_HORIZONTAL, resolveItemTextColumnInset } from '@/components/ui/lists/itemDensityMetrics';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { MeterBar } from '@/components/ui/lists/MeterBar';
import { Text } from '@/components/ui/text/Text';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { invokeTauri, isTauriDesktop } from '@/utils/platform/tauri';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { UpdateItem } from '@/updates/items/updateItem';

import { describeUpdateItem } from './describeUpdateItem';
import { UpdatesTextButton } from './UpdatesTextButton';

export type UpdateRowPresentation = 'popover' | 'screen';

function resolveIconName(item: UpdateItem): IconName {
    if (item.subject.kind === 'happier-cli') return 'terminal';
    if (item.subject.kind === 'installable') {
        const key = item.subject.key;
        const entry = getInstallablesRegistryEntries().find((candidate) => candidate.key === key);
        return (entry?.iconName ?? 'cube') as IconName;
    }
    if (isTauriDesktop()) return 'desktop';
    return Platform.OS === 'web' ? 'globe' : 'device-mobile';
}

/**
 * One update row, identical in both densities: identity on the left, one status line, and a
 * fixed-width action slot on the right that resolves in place (Update → spinner / percent → Retry)
 * while the title and icon never move. Its words come from `describeUpdateItem`; its state from
 * the item's producer. Progress shows only when the producer reports a real fraction.
 */
export const UpdateRow = React.memo(function UpdateRow(props: Readonly<{
    item: UpdateItem;
    /** Where the row lives, for labels that must name the object ("Update Codex on Studio"). */
    where: string;
    presentation: UpdateRowPresentation;
    /** When "Update all" is the one primary action, row buttons render as secondary. */
    secondaryAction: boolean;
    onRun: (item: UpdateItem) => void;
    onLongPress?: () => void;
    showDivider?: boolean;
    /** The row lives on this computer, where the desktop app can open its log file. */
    isThisComputer?: boolean;
    /** Sessions are running on the row's machine now (a quiet note on service-restarting rows). */
    sessionsRunning?: boolean;
}>) {
    const { theme } = useUnistyles();
    const { item } = props;
    const compact = props.presentation === 'popover';
    const presentation = describeUpdateItem(item, { sessionsRunning: props.sessionsRunning });
    const iconSize = compact ? ICON_SIZE.sm : ICON_SIZE.xl;
    const onRun = props.onRun;
    const run = React.useCallback(() => {
        if (Platform.OS === 'ios' || Platform.OS === 'android') hapticsLight();
        onRun(item);
    }, [item, onRun]);

    const icon = item.subject.kind === 'agent-cli'
        // Brand marks are drawn full-bleed; one step smaller matches the glyphs' optical ink.
        ? <AgentIcon agentId={item.subject.agentId as AgentId} size={compact ? ICON_SIZE.sm : ICON_SIZE.lg} />
        : <Icon name={resolveIconName(item)} size={iconSize} color={theme.colors.text.secondary} />;

    const percent = item.state === 'running' ? item.progressPercent : null;
    const canOpenLog = props.isThisComputer === true && isTauriDesktop();
    const logPath = item.logPath ?? null;
    const copyFeedback = useTemporaryCopyFeedback();
    const markCopied = copyFeedback.markCopied;
    // A quiet secondary action of the failed row: on this computer the desktop app opens the log;
    // elsewhere the log lives on that machine, so its path is copied (with the copied feedback).
    const viewLog = React.useCallback(() => {
        if (!logPath) return;
        if (canOpenLog) {
            fireAndForget(invokeTauri<void>('system_tasks_open_log_path', { path: logPath }), { tag: 'UpdateRow.openLog' });
            return;
        }
        fireAndForget(setClipboardStringSafe(logPath).then((copied) => {
            if (copied) markCopied();
        }), { tag: 'UpdateRow.copyLogPath' });
    }, [canOpenLog, logPath, markCopied]);
    const showViewLog = !compact && item.state === 'failed' && logPath != null;
    const rowLabel = t('updates.a11y.rowOn', { title: item.title, where: props.where });
    const actionLabel = presentation.actionLabel;

    // One settle for every swap in the slot (Update → spinner/percent → ✓ or Retry): the box is
    // laid out by the widest label this row can show, so no state moves the title.
    const slotKey = actionLabel
        ? `action:${actionLabel}`
        : item.state === 'running'
            ? (percent != null ? 'percent' : 'spinner')
            : item.state === 'upToDate' ? 'check' : 'none';
    const slot = (
        <StatusTransition
            transitionKey={slotKey}
            fromScale={ICON_CIRCLE_INK_RATIO}
            sizing={<RoundButton size="small" title={presentation.sizingLabel} display="inverted" disabled />}
            testID={`updates.row.${item.id}.slot`}
        >
            <View style={styles.slotContent}>
                {actionLabel ? (
                    <RoundButton
                        size="small"
                        title={actionLabel}
                        display={props.secondaryAction ? 'inverted' : 'default'}
                        onPress={run}
                        testID={`updates.row.${item.id}.action`}
                        accessibilityLabel={t('updates.a11y.actionOn', { action: actionLabel, title: item.title, where: props.where })}
                    />
                ) : item.state === 'running' ? (
                    percent != null ? (
                        <Text style={[styles.percent, compact ? styles.percentCompact : null, Typography.tabular()]}>{`${percent}%`}</Text>
                    ) : (
                        <ActivitySpinner size={iconMatchedSpinnerSize(ICON_SIZE.sm)} style={styles.spinner} testID={`updates.row.${item.id}.spinner`} />
                    )
                ) : item.state === 'upToDate' ? (
                    <Icon name="check" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
                ) : null}
            </View>
        </StatusTransition>
    );

    return (
        <View style={styles.row} testID={`updates.row.${item.id}`}>
            <Item
                title={item.title}
                subtitle={[presentation.subtitle, presentation.note, presentation.command].filter(Boolean).join('\n')}
                subtitleLines={0}
                icon={icon}
                density={compact ? 'compact' : undefined}
                rightElement={showViewLog ? (
                    <View style={styles.actions}>
                        {copyFeedback.isCopied() ? (
                            <CopiedPill visible testID={`updates.row.${item.id}.viewLog.copied`} />
                        ) : (
                            <UpdatesTextButton
                                label={t('updates.action.viewLog')}
                                accessibilityLabel={t('updates.a11y.actionOn', { action: t('updates.action.viewLog'), title: item.title, where: props.where })}
                                onPress={viewLog}
                                testID={`updates.row.${item.id}.viewLog`}
                            />
                        )}
                        {slot}
                    </View>
                ) : slot}
                showChevron={false}
                mode="info"
                copy={presentation.command ?? undefined}
                onLongPress={props.onLongPress}
                showDivider={props.showDivider}
                accessibilityLabel={[rowLabel, presentation.subtitle, presentation.note].filter(Boolean).join(', ')}
                accessibilityState={{ busy: item.state === 'running' }}
            />
            {percent != null ? (
                <View style={[styles.hairline, compact ? styles.hairlineCompact : styles.hairlineComfortable]} pointerEvents="none">
                    <MeterBar
                        tone="neutral"
                        height={2}
                        fillFraction={percent / 100}
                        trackColor={theme.colors.border.default}
                        progressAccessibilityLabel={t('updates.a11y.progress', { percent })}
                    />
                </View>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    row: {
        position: 'relative',
    },
    slotContent: {
        alignSelf: 'stretch',
        alignItems: 'flex-end',
        justifyContent: 'center',
    },
    // The spinner centres itself by default; in the slot it sits on the same right edge as the
    // check and the percent, so the mark does not jump sideways between states.
    spinner: {
        alignSelf: 'flex-end',
    },
    percent: {
        color: theme.colors.text.secondary,
        fontSize: Platform.select({ ios: 15, default: 14 }),
    },
    percentCompact: {
        fontSize: Platform.select({ ios: 14, default: 13 }),
    },
    hairline: {
        position: 'absolute',
        bottom: 0,
    },
    // Starts under the title's text column, not under the icon: row padding + icon box + gap.
    hairlineCompact: {
        left: resolveItemTextColumnInset('compact'),
        right: ITEM_ROW_PADDING_HORIZONTAL.compact,
    },
    hairlineComfortable: {
        left: resolveItemTextColumnInset('comfortable'),
        right: ITEM_ROW_PADDING_HORIZONTAL.comfortable,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 16,
    },
}));
