import * as React from 'react';
import { View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRelayDriftBanner } from '@/components/settings/server/useRelayDriftBanner';
import { useRelayDriftSummary } from '@/components/settings/server/useRelayDriftSummary';
import { SystemTaskProgressCard } from '@/components/systemTasks/SystemTaskProgressCard';
import { Icon } from '@/components/ui/icons/Icon';
import { ActionListSection } from '@/components/ui/lists/ActionListSection';
import { Text } from '@/components/ui/text/Text';
import { describeThisComputerRelayRow } from '@/setup/thisComputerLabels';
import { listThisComputerRelayRows, type ThisComputerRelayRow } from '@/setup/thisComputerRelayRows';
import { useDesktopLocalInspection } from '@/setup/useDesktopLocalInspection';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';

const stylesheet = StyleSheet.create(() => ({
    relays: {
        flexShrink: 1,
        alignItems: 'flex-end',
        gap: 4,
    },
    relay: {
        alignItems: 'flex-end',
    },
}));

/**
 * U7/R17 — the connection popover's "This computer" rows: every relay this computer has a service
 * for (one daemon per relay — the default-following service and each relay's own pinned one), each
 * with its state from the one projection (`resolveThisComputerRelayState`: connected, set up but
 * offline, or needs attention), the drift sentence that names the relay and both accounts when the
 * app's relay is not served as it needs, and then the one action that connects it. That action is
 * the drift banner's repair, so it asks the coordinator's one move question — "Move", "Connect to …
 * too" or "Keep" — never a second decision of its own.
 *
 * It is its own leaf, mounted only while the popover is open, so the always-mounted status chip
 * never holds the inspection subscription (`apps/ui/AGENTS.md`). Desktop only: no other surface
 * knows this computer's daemons.
 */
export function ThisComputerStatusRow(props: Readonly<{
    rowStyle: StyleProp<ViewStyle>;
    labelStyle: StyleProp<TextStyle>;
    valueStyle: StyleProp<TextStyle>;
    actionListStyle?: StyleProp<ViewStyle>;
}>): React.ReactElement | null {
    const { inspection } = useDesktopLocalInspection(true);
    const summary = useRelayDriftSummary();
    const { serverUrl, activeLocalRelayUrl } = getActiveServerSnapshot();
    const appAccountId = getActiveServerAccountScope()?.accountId ?? null;
    const relays = React.useMemo((): readonly ThisComputerRelayRow[] => {
        const listed = listThisComputerRelayRows(inspection, { relayUrl: serverUrl, localRelayUrl: activeLocalRelayUrl ?? null, accountId: appAccountId });
        return listed.status === 'listed' ? listed.rows : [];
    }, [activeLocalRelayUrl, appAccountId, inspection, serverUrl]);

    if (relays.length === 0 && !summary) {
        return null;
    }
    return (
        <>
            <View style={props.rowStyle} testID="connection-popover-this-computer">
                <Text style={props.labelStyle}>{t('connectionStatus.labels.thisComputer')}</Text>
                <View style={stylesheet.relays}>
                    {relays.map((row) => {
                        const text = describeThisComputerRelayRow(row);
                        return (
                            <View
                                key={row.relayUrl}
                                testID="connection-popover-this-computer-relay"
                                style={stylesheet.relay}
                                accessible
                                accessibilityLabel={text.accessibilityLabel}
                            >
                                <Text style={props.valueStyle} numberOfLines={1}>{text.title}</Text>
                                <Text style={props.labelStyle} numberOfLines={1}>{text.state}</Text>
                            </View>
                        );
                    })}
                    {summary ? <Text style={props.valueStyle} numberOfLines={3}>{summary.description}</Text> : null}
                </View>
            </View>
            {summary ? <ConnectThisComputerAction style={props.actionListStyle} /> : null}
        </>
    );
}

/** A lazy presentation of the coordinator's operation; closing it leaves the responder intact. */
function ConnectThisComputerAction(props: Readonly<{ style?: StyleProp<ViewStyle> }>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const banner = useRelayDriftBanner();
    if (!banner) {
        return null;
    }
    const running = banner.repairTaskSnapshot != null && banner.repairTaskSnapshot.result == null;
    return (
        <>
            <ActionListSection
                style={props.style}
                actions={[{
                    id: 'connect-this-computer',
                    testID: 'connection-popover-connect-this-computer',
                    label: banner.isRepairStarting || running ? t('common.loading') : banner.actionLabel,
                    ...(banner.actionHint ? { subtitle: banner.actionHint } : {}),
                    icon: <Icon name="arrows-left-right" size={16} color={theme.colors.text.secondary} />,
                    disabled: banner.actionDisabled === true || banner.isRepairStarting || running,
                    onPress: () => {
                        void banner.onPress();
                    },
                }]}
            />
            {banner.repairTaskSnapshot && banner.repairTaskSnapshot.result?.ok !== true ? (
                <SystemTaskProgressCard
                    snapshot={banner.repairTaskSnapshot}
                    title={t('server.relayDrift.progressTitle')}
                    onCancel={banner.onCancelRepair}
                />
            ) : null}
        </>
    );
}
