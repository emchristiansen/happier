import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RELEASED_CONNECTED_SERVICE_IDS, type ConnectedServiceId } from '@happier-dev/protocol';
import { getMachineConnectedServiceAuthSupportedServiceIds } from '@/sync/ops/connectedServiceAuthSupport';

import { resolveConnectedServiceDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { ConnectedServiceQuotaBadgesView } from '@/components/settings/connectedServices/ConnectedServiceQuotaBadgesView';
import { useConnectedServiceQuotaBadges } from '@/hooks/server/connectedServices/useConnectedServiceQuotaBadges';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { StatusPill } from '@/components/ui/selectionList/accessories/StatusPill';
import { SelectionList, resolvePopoverSelectionListHeightBehavior } from '@/components/ui/selectionList';
import type { ConnectedServicesServiceBinding } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { t } from '@/text';

import type {
    ConnectedServicesAccountGroupOptionsByServiceId,
    ConnectedServicesProfileOptionsByServiceId,
} from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import { isConnectedServiceProfileOptionSelectable } from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import { buildNewSessionConnectedServicesSelectionListModel } from './buildNewSessionConnectedServicesSelectionListModel';
import type { ConnectedServicesSelectionOptionAvailability } from './buildNewSessionConnectedServicesSelectionListModel';
import { Icon } from '@/components/ui/icons/Icon';

export type NewSessionConnectedServicesSelectionContentProps = Readonly<{
    supportedServiceIds: ReadonlyArray<ConnectedServiceId>;
    profileOptionsByServiceId: ConnectedServicesProfileOptionsByServiceId;
    accountGroupOptionsByServiceId?: ConnectedServicesAccountGroupOptionsByServiceId;
    bindingsByServiceId: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;
    setBindingForService: (serviceId: string, binding: ConnectedServicesServiceBinding) => void;
    defaultProfileIdByServiceId?: Readonly<Record<string, string | undefined>>;
    resolveOptionAvailability?: (params: Readonly<{
        serviceId: string;
        optionId: string;
        binding: ConnectedServicesServiceBinding;
    }>) => ConnectedServicesSelectionOptionAvailability;
    onReconnectProfile?: (serviceId: string, profileId: string) => void;
    onOpenSettings: (serviceId: string) => void;
    requestClose?: () => void;
    maxHeight: number;
    launchTarget?: Readonly<{ machineId: string | null; serverId: string | null; agentId: string }>;
}>;

const releasedServiceIds: ReadonlySet<string> = new Set(RELEASED_CONNECTED_SERVICE_IDS);

function SelectionStateIcon(props: Readonly<{ selected: boolean; variant?: 'default' | 'warning' }>) {
    const { theme } = useUnistyles();
    const color = props.variant === 'warning'
        ? theme.colors.accent.orange
        : theme.colors.accent.blue;

    return normalizeNodeForView(
        <Icon
            name={props.selected ? 'check-circle' : 'circle'}
            size={20}
            color={color}
        />,
    );
}

function SettingsActionIcon() {
    const { theme } = useUnistyles();
    return normalizeNodeForView(
        <Icon name="sliders-horizontal" size={20} color={theme.colors.text.tertiary} />,
    );
}

export function NewSessionConnectedServicesSelectionContent(props: NewSessionConnectedServicesSelectionContentProps) {
    const styles = stylesheet;
    const [bindingsByServiceId, setBindingsByServiceId] = React.useState(props.bindingsByServiceId);
    const machineId = props.launchTarget?.machineId;
    const serverId = props.launchTarget?.serverId;
    const agentId = props.launchTarget?.agentId;
    const supportKey = JSON.stringify([machineId, serverId, agentId]);
    const needsLaunchAdmission = props.launchTarget !== undefined && props.supportedServiceIds.some((id) => !releasedServiceIds.has(id));
    const [launchSupport, setLaunchSupport] = React.useState<Readonly<{ key: string; serviceIds: readonly string[] }> | null>(null);
    React.useEffect(() => {
        if (!needsLaunchAdmission || !machineId || !agentId) return;
        let cancelled = false;
        void getMachineConnectedServiceAuthSupportedServiceIds({ machineId, serverId, agentId }).then((serviceIds) => {
            if (!cancelled) setLaunchSupport({ key: supportKey, serviceIds });
        });
        return () => { cancelled = true; };
    }, [agentId, machineId, needsLaunchAdmission, serverId, supportKey]);
    const resolveOptionAvailability = React.useCallback<NonNullable<NewSessionConnectedServicesSelectionContentProps['resolveOptionAvailability']>>((params) => {
        if (needsLaunchAdmission && !releasedServiceIds.has(params.serviceId) && params.binding.source === 'connected'
            && (launchSupport?.key !== supportKey || !launchSupport.serviceIds.includes(params.serviceId))) {
            return { disabled: true, subtitle: t('connectedServices.defaultAuth.warning.connected_service_unsupported') };
        }
        return props.resolveOptionAvailability?.(params) ?? {};
    }, [launchSupport, needsLaunchAdmission, props.resolveOptionAvailability, supportKey]);

    React.useEffect(() => {
        setBindingsByServiceId(props.bindingsByServiceId);
    }, [props.bindingsByServiceId]);

    const requestedProfiles = React.useMemo(() => {
        const next: Array<{ serviceId: string; profileId: string; credentialHealthStatus?: unknown }> = [];
        for (const serviceId of props.supportedServiceIds) {
            const options = props.profileOptionsByServiceId[serviceId] ?? [];
            for (const option of options) {
                if (!isConnectedServiceProfileOptionSelectable(option)) continue;
                const profileId = option.profileId.trim();
                if (!profileId) continue;
                next.push({ serviceId, profileId, credentialHealthStatus: option.status });
            }
        }
        return next;
    }, [props.profileOptionsByServiceId, props.supportedServiceIds]);

    const quotaBadgesByKey = useConnectedServiceQuotaBadges(requestedProfiles);

    // The row handlers are BEHAVIOUR, not data, so they are held in a ref and
    // invoked through stable wrappers instead of being memo dependencies.
    //
    // All three hosts build this content through a render callback that the
    // hosting surface re-invokes with a freshly created element on every render
    // while it is open (the popover hosts at minimum once more when the measured
    // placement lands). Two of them cannot hoist their handlers at all —
    // `useSessionConnectedServicesAuthSwitch` closes each one over the
    // per-invocation `requestClose` — so with the raw handlers in the dependency
    // list, every one of those passes rebuilt the whole step tree: each option
    // object plus its `icon` and `rightAccessory` elements. React then lost
    // element identity for every row and re-rendered each row's icon, quota
    // badges and reauth pill instead of skipping them. Only the DATA inputs
    // below may invalidate the model; a replaced handler is picked up through
    // the ref on the next activation.
    const handlersRef = React.useRef({
        setBindingForService: props.setBindingForService,
        onOpenSettings: props.onOpenSettings,
        onReconnectProfile: props.onReconnectProfile,
    });
    handlersRef.current = {
        setBindingForService: props.setBindingForService,
        onOpenSettings: props.onOpenSettings,
        onReconnectProfile: props.onReconnectProfile,
    };

    const setBindingForService = React.useCallback((serviceId: string, binding: ConnectedServicesServiceBinding) => {
        setBindingsByServiceId((prev) => ({ ...prev, [serviceId]: binding }));
        handlersRef.current.setBindingForService(serviceId, binding);
    }, []);
    const openSettings = React.useCallback((serviceId: string) => {
        handlersRef.current.onOpenSettings(serviceId);
    }, []);
    const reconnectProfileHandler = React.useCallback((serviceId: string, profileId: string) => {
        handlersRef.current.onReconnectProfile?.(serviceId, profileId);
    }, []);
    // Presence (not identity) of the reconnect handler is a real render input:
    // without one the builder routes the reauth row to the settings action.
    const reconnectProfile = typeof props.onReconnectProfile === 'function'
        ? reconnectProfileHandler
        : undefined;

    const listModel = React.useMemo(() => {
        return buildNewSessionConnectedServicesSelectionListModel({
            supportedServiceIds: props.supportedServiceIds,
            profileOptionsByServiceId: props.profileOptionsByServiceId,
            accountGroupOptionsByServiceId: props.accountGroupOptionsByServiceId,
            bindingsByServiceId,
            defaultProfileIdByServiceId: props.defaultProfileIdByServiceId,
            quotaBadgesByKey,
            setBindingForService,
            onOpenSettings: openSettings,
            translate: t,
            resolveServiceTitle: (serviceId) => resolveConnectedServiceDisplayName(serviceId as ConnectedServiceId, t),
            renderSelectionIcon: ({ selected, variant }) => <SelectionStateIcon selected={selected} variant={variant} />,
            renderSettingsIcon: () => <SettingsActionIcon />,
            renderQuotaBadges: (badges) => <ConnectedServiceQuotaBadgesView badges={badges} />,
            renderNeedsReauthPill: () => (
                <StatusPill
                    variant="stale"
                    label={t('connectedServices.list.needsReauth')}
                    hideDot
                />
            ),
            onReconnectProfile: reconnectProfile,
            resolveOptionAvailability,
        });
    }, [
        bindingsByServiceId,
        openSettings,
        props.accountGroupOptionsByServiceId,
        props.defaultProfileIdByServiceId,
        props.profileOptionsByServiceId,
        // Kept as a dependency on purpose: unlike the handlers above, this one is
        // INVOKED during the build and its result is baked into every option's
        // `disabled` / `subtitle` / icon variant, so a stale reference would
        // freeze availability. Each host supplies it as a memoised callback.
        resolveOptionAvailability,
        props.supportedServiceIds,
        quotaBadgesByKey,
        reconnectProfile,
        setBindingForService,
    ]);

    return (
        <View style={[styles.container, { maxHeight: props.maxHeight }]}>
            <SelectionList
                testID="new-session.connected-services.selection-list"
                rootStep={listModel.rootStep}
                selectedOptionId={listModel.selectedOptionId}
                maxHeight={props.maxHeight}
                heightBehavior={resolvePopoverSelectionListHeightBehavior()}
                keyboardHintsEnabled={false}
                onRequestClose={() => {
                    props.requestClose?.();
                }}
                onSelect={() => {
                    props.requestClose?.();
                }}
            />
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        backgroundColor: theme.colors.background.canvas,
        flexShrink: 1,
    },
}));
