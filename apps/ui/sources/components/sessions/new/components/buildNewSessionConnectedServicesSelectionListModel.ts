import type * as React from 'react';

import {
    type SelectionListOption,
    type SelectionListSectionDescriptor,
    type SelectionListStep,
} from '@/components/ui/selectionList';
import { connectedServiceProfileKey, resolveConnectedServiceDefaultProfileId } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import type { ConnectedServicesServiceBinding } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import {
    formatConnectedServiceIdentityVisibleLabel,
    resolveConnectedServiceGroupIdentityDisplay,
} from '@/components/settings/connectedServices/model/resolveConnectedServiceIdentityDisplay';

import type {
    ConnectedServicesAccountGroupOption,
    ConnectedServicesAccountGroupReadiness,
    ConnectedServicesProfileOption,
    ConnectedServicesProfileOptionsByServiceId,
} from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import {
    isConnectedServiceProfileOptionSelectable,
    resolveConnectedServiceAccountGroupViableProfileId,
} from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';

export type ConnectedServicesSelectionListBadge = Readonly<{
    meterId: string;
    text: string;
}>;

export type ConnectedServicesSelectionOptionAvailability = Readonly<{
    disabled?: boolean;
    subtitle?: string;
}>;

export type ConnectedServicesSelectionIconVariant = 'default' | 'warning';

export type ConnectedServicesSelectionListTranslationKey =
    | 'connectedServices.authModal.groupReadySubtitle'
    | 'connectedServices.authModal.groupExhaustedSubtitle'
    | 'connectedServices.authModal.groupNeedsMembersSubtitle'
    | 'connectedServices.authModal.groupSwitchingSubtitle'
    | 'connectedServices.authModal.startOnMember'
    | 'connectedServices.authModal.groupErrorSubtitle'
    | 'connectedServices.authModal.groupUnknownSubtitle'
    | 'connectedServices.authModal.nativeAuthTitle'
    | 'connectedServices.authModal.nativeAuthSubtitle'
    | 'connectedServices.authModal.notConnectedTitle'
    | 'connectedServices.authModal.notConnectedSubtitle'
    | 'connectedServices.title'
    | 'connectedServices.defaultAuth.warning.connected_service_unsupported'
    | 'connectedServices.detail.connectSetupTokenSubtitle';

type ConnectedServicesSelectionListActiveMemberTranslate = (
    key: 'connectedServices.detail.groups.activeMember',
    params: { member: string },
) => string;

export type NewSessionConnectedServicesSelectionListModel = Readonly<{
    rootStep: SelectionListStep;
    selectedOptionId: string | null;
}>;

export type BuildNewSessionConnectedServicesSelectionListModelParams = Readonly<{
    supportedServiceIds: ReadonlyArray<string>;
    profileOptionsByServiceId: ConnectedServicesProfileOptionsByServiceId;
    accountGroupOptionsByServiceId?: Readonly<Record<string, ReadonlyArray<ConnectedServicesAccountGroupOption> | undefined>>;
    bindingsByServiceId: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;
    defaultProfileIdByServiceId?: Readonly<Record<string, string | undefined>>;
    quotaBadgesByKey: Readonly<Record<string, ReadonlyArray<ConnectedServicesSelectionListBadge> | undefined>>;
    setBindingForService: (serviceId: string, binding: ConnectedServicesServiceBinding) => void;
    onOpenSettings: (serviceId: string) => void;
    translate: (key: ConnectedServicesSelectionListTranslationKey) => string;
    resolveServiceTitle: (serviceId: string) => string;
    renderSelectionIcon: (params: Readonly<{ selected: boolean; variant?: ConnectedServicesSelectionIconVariant }>) => React.ReactNode;
    renderSettingsIcon: () => React.ReactNode;
    renderQuotaBadges: (badges: ReadonlyArray<ConnectedServicesSelectionListBadge>) => React.ReactNode;
    renderNeedsReauthPill: () => React.ReactNode;
    onReconnectProfile?: (serviceId: string, profileId: string) => void;
    resolveOptionAvailability?: (params: Readonly<{
        serviceId: string;
        optionId: string;
        binding: ConnectedServicesServiceBinding;
    }>) => ConnectedServicesSelectionOptionAvailability;
}>;

export function createConnectedServiceOptionId(serviceId: string, profileId: string): string {
    return `connected-service:${encodeURIComponent(serviceId)}:profile:${encodeURIComponent(profileId)}`;
}

export function createConnectedServiceGroupOptionId(serviceId: string, groupId: string): string {
    return `connected-service:${encodeURIComponent(serviceId)}:group:${encodeURIComponent(groupId)}`;
}

export function createNativeServiceOptionId(serviceId: string): string {
    return `connected-service:${encodeURIComponent(serviceId)}:native`;
}

export function createConnectServiceOptionId(serviceId: string): string {
    return `connected-service:${encodeURIComponent(serviceId)}:connect`;
}

export function createReauthServiceOptionId(serviceId: string, profileId: string): string {
    return `connected-service:${encodeURIComponent(serviceId)}:reauth:${encodeURIComponent(profileId)}`;
}

function resolveProfileTitle(option: ConnectedServicesProfileOption): string {
    const label = (option.label ?? '').trim();
    if (label) return label;

    const providerEmail = (option.providerEmail ?? '').trim();
    if (providerEmail) return providerEmail;

    return option.profileId;
}

function resolveProfileSubtitle(option: ConnectedServicesProfileOption): string | undefined {
    const label = (option.label ?? '').trim();
    const providerEmail = (option.providerEmail ?? '').trim();

    if (label && providerEmail) return `${option.profileId} · ${providerEmail}`;
    if (label) return option.profileId;
    if (providerEmail && providerEmail !== option.profileId) return option.profileId;
    return undefined;
}

function resolveGroupSubtitleKey(status: ConnectedServicesAccountGroupReadiness): ConnectedServicesSelectionListTranslationKey {
    if (status === 'exhausted') return 'connectedServices.authModal.groupExhaustedSubtitle';
    if (status === 'needs_members') return 'connectedServices.authModal.groupNeedsMembersSubtitle';
    if (status === 'switching') return 'connectedServices.authModal.groupSwitchingSubtitle';
    if (status === 'error') return 'connectedServices.authModal.groupErrorSubtitle';
    if (status === 'unknown') return 'connectedServices.authModal.groupUnknownSubtitle';
    return 'connectedServices.authModal.groupReadySubtitle';
}

function resolveGroupSubtitle(params: Readonly<{
    group: ConnectedServicesAccountGroupOption;
    profiles: ReadonlyArray<ConnectedServicesProfileOption>;
    translate: (key: ConnectedServicesSelectionListTranslationKey) => string;
}>): string {
    const fallback = params.translate(resolveGroupSubtitleKey(params.group.status));
    if (params.group.status !== 'ready') return fallback;

    const identity = resolveConnectedServiceGroupIdentityDisplay({
        group: params.group,
        profiles: params.profiles,
    });
    if (!identity.activeMember) return fallback;

    const translateActiveMember = params.translate as typeof params.translate & ConnectedServicesSelectionListActiveMemberTranslate;
    return translateActiveMember('connectedServices.detail.groups.activeMember', {
        member: formatConnectedServiceIdentityVisibleLabel(identity.activeMember),
    });
}

function readOptionalString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function resolveServiceOptionAccessibilityLabel(params: Readonly<{
    serviceTitle: string;
    optionLabel: string;
}>): string | undefined {
    const serviceTitle = params.serviceTitle.trim();
    const optionLabel = params.optionLabel.trim();
    if (!serviceTitle || !optionLabel) return undefined;
    return `${serviceTitle} · ${optionLabel}`;
}

function resolveAvailability(params: Readonly<{
    rootParams: BuildNewSessionConnectedServicesSelectionListModelParams;
    serviceId: string;
    optionId: string;
    binding: ConnectedServicesServiceBinding;
}>): ConnectedServicesSelectionOptionAvailability {
    return params.rootParams.resolveOptionAvailability?.({
        serviceId: params.serviceId,
        optionId: params.optionId,
        binding: params.binding,
    }) ?? {};
}

export function buildNewSessionConnectedServicesSelectionListModel(
    params: BuildNewSessionConnectedServicesSelectionListModelParams,
): NewSessionConnectedServicesSelectionListModel {
    let firstSelectedOptionId: string | null = null;
    const sections: SelectionListSectionDescriptor[] = params.supportedServiceIds.map((serviceId) => {
        const serviceTitle = params.resolveServiceTitle(serviceId);
        const serviceOptions = params.profileOptionsByServiceId[serviceId] ?? [];
        const selectableProfiles = serviceOptions.filter(isConnectedServiceProfileOptionSelectable);
        const unavailableProfiles = serviceOptions.filter((option) => !isConnectedServiceProfileOptionSelectable(option));
        const selectableProfileIds = selectableProfiles.map((option) => option.profileId.trim()).filter(Boolean);
        const binding = params.bindingsByServiceId[serviceId];
        const groupOptions = params.accountGroupOptionsByServiceId?.[serviceId] ?? [];
        const explicitProfileId = binding?.source === 'connected' && binding.selection !== 'group'
            ? readOptionalString(binding.profileId)
            : '';
        const explicitGroupId = binding?.source === 'connected' && binding.selection === 'group'
            ? readOptionalString(binding.groupId)
            : '';
        const selectedGroup = binding?.source === 'connected' && binding.selection === 'group' && explicitGroupId
            ? groupOptions.find((option) => option.groupId === explicitGroupId)
            : null;
        const unresolvedGroupBinding = binding?.source === 'connected' && binding.selection === 'group' && explicitGroupId && !selectedGroup;
        const effectiveProfileId = binding?.source === 'connected' && !unresolvedGroupBinding
            ? selectedGroup
                ? resolveConnectedServiceAccountGroupViableProfileId({ group: selectedGroup, connectedProfileIds: selectableProfileIds })
                : explicitProfileId && selectableProfileIds.includes(explicitProfileId)
                ? explicitProfileId
                : resolveConnectedServiceDefaultProfileId({
                    serviceId,
                    connectedProfileIds: selectableProfileIds,
                    defaultProfileByServiceId: params.defaultProfileIdByServiceId ?? {},
                })
            : null;
        const usesConnectedProfile = Boolean(effectiveProfileId);
        const options: SelectionListOption[] = [];

        for (const group of groupOptions) {
            const groupId = group.groupId.trim();
            const fallbackProfileId = resolveConnectedServiceAccountGroupViableProfileId({ group, connectedProfileIds: selectableProfileIds });
            if (!groupId) continue;
            const selected = selectedGroup?.groupId === groupId;
            const optionId = createConnectedServiceGroupOptionId(serviceId, groupId);
            const quotaBadges = fallbackProfileId
                ? params.quotaBadgesByKey[connectedServiceProfileKey({ serviceId, profileId: fallbackProfileId })] ?? []
                : [];
            const optionBinding = {
                source: 'connected',
                selection: 'group',
                groupId,
            } satisfies ConnectedServicesServiceBinding;
            const availability = resolveAvailability({
                rootParams: params,
                serviceId,
                optionId,
                binding: optionBinding,
            });
            if (selected && firstSelectedOptionId === null) firstSelectedOptionId = optionId;
            const label = group.label;
            options.push({
                id: optionId,
                label,
                subtitle: availability.subtitle ?? resolveGroupSubtitle({
                    group,
                    profiles: serviceOptions,
                    translate: params.translate,
                }),
                accessibilityLabel: resolveServiceOptionAccessibilityLabel({ serviceTitle, optionLabel: label }),
                icon: params.renderSelectionIcon({
                    selected,
                    variant: availability.disabled || group.status !== 'ready' || !fallbackProfileId ? 'warning' : 'default',
                }),
                disabled: availability.disabled === true || group.status !== 'ready' || !fallbackProfileId,
                rightAccessory: quotaBadges.length > 0
                    ? params.renderQuotaBadges(quotaBadges)
                    : undefined,
                onSelect: () => params.setBindingForService(serviceId, {
                    source: 'connected',
                    selection: 'group',
                    groupId,
                }),
            });
            // A selected per-session pool offers an optional named start member (spec A.1).
            if (selected && group.assignment === 'per_session' && !availability.disabled) {
                const requestedProfileId = binding?.source === 'connected' && binding.selection === 'group'
                    ? readOptionalString(binding.initialProfileId)
                    : '';
                for (const memberProfileId of group.memberProfileIds ?? []) {
                    const member = selectableProfiles.find((option) => option.profileId.trim() === memberProfileId);
                    if (!member) continue;
                    const startOptionId = `${optionId}:start:${encodeURIComponent(memberProfileId)}`;
                    const startSelected = requestedProfileId === memberProfileId;
                    const startLabel = `${params.translate('connectedServices.authModal.startOnMember')}: ${resolveProfileTitle(member)}`;
                    const memberBadges = params.quotaBadgesByKey[connectedServiceProfileKey({ serviceId, profileId: memberProfileId })] ?? [];
                    options.push({
                        id: startOptionId,
                        label: startLabel,
                        accessibilityLabel: resolveServiceOptionAccessibilityLabel({ serviceTitle, optionLabel: startLabel }),
                        icon: params.renderSelectionIcon({ selected: startSelected }),
                        rightAccessory: memberBadges.length > 0 ? params.renderQuotaBadges(memberBadges) : undefined,
                        onSelect: () => params.setBindingForService(serviceId, startSelected
                            ? { source: 'connected', selection: 'group', groupId }
                            : { source: 'connected', selection: 'group', groupId, initialProfileId: memberProfileId }),
                    });
                }
            }
        }

        for (const option of selectableProfiles) {
            const profileId = option.profileId.trim();
            if (!profileId) continue;
            const optionId = createConnectedServiceOptionId(serviceId, profileId);
            const selected = !selectedGroup && usesConnectedProfile && effectiveProfileId === profileId;
            const optionBinding = { source: 'connected', selection: 'profile', profileId } satisfies ConnectedServicesServiceBinding;
            const availability = resolveAvailability({
                rootParams: params,
                serviceId,
                optionId,
                binding: optionBinding,
            });
            if (selected && firstSelectedOptionId === null) firstSelectedOptionId = optionId;
            const profileKey = connectedServiceProfileKey({ serviceId, profileId });
            const quotaBadges = params.quotaBadgesByKey[profileKey] ?? [];
            const label = resolveProfileTitle(option);

            options.push({
                id: optionId,
                label,
                subtitle: availability.subtitle ?? resolveProfileSubtitle(option),
                accessibilityLabel: resolveServiceOptionAccessibilityLabel({ serviceTitle, optionLabel: label }),
                icon: params.renderSelectionIcon({
                    selected,
                    variant: availability.disabled || option.status !== 'connected' ? 'warning' : 'default',
                }),
                disabled: availability.disabled === true,
                rightAccessory: quotaBadges.length > 0
                    ? params.renderQuotaBadges(quotaBadges)
                    : undefined,
                onSelect: () => params.setBindingForService(serviceId, { source: 'connected', selection: 'profile', profileId }),
            });
        }

        for (const option of unavailableProfiles) {
            const profileId = option.profileId.trim();
            if (!profileId) continue;
            const unsupportedKind = option.status === 'unsupported_kind';
            const label = resolveProfileTitle(option);
            options.push({
                id: createReauthServiceOptionId(serviceId, profileId),
                label,
                subtitle: unsupportedKind
                    ? params.translate(option.unsupportedSubtitleKey ?? 'connectedServices.defaultAuth.warning.connected_service_unsupported')
                    : resolveProfileSubtitle(option),
                accessibilityLabel: resolveServiceOptionAccessibilityLabel({ serviceTitle, optionLabel: label }),
                icon: params.renderSelectionIcon({ selected: false, variant: 'warning' }),
                rightAccessory: params.renderNeedsReauthPill(),
                onSelect: unsupportedKind
                    ? () => params.onOpenSettings(serviceId)
                    : params.onReconnectProfile
                    ? () => params.onReconnectProfile?.(serviceId, profileId)
                    : () => params.onOpenSettings(serviceId),
            });
        }

        const nativeOptionId = createNativeServiceOptionId(serviceId);
        const nativeSelected = !usesConnectedProfile && !selectedGroup;
        const nativeBinding = { source: 'native' } satisfies ConnectedServicesServiceBinding;
        const nativeAvailability = resolveAvailability({
            rootParams: params,
            serviceId,
            optionId: nativeOptionId,
            binding: nativeBinding,
        });
        if (nativeSelected && firstSelectedOptionId === null) firstSelectedOptionId = nativeOptionId;
        const nativeLabel = params.translate('connectedServices.authModal.nativeAuthTitle');
        options.push({
            id: nativeOptionId,
            label: nativeLabel,
            subtitle: nativeAvailability.subtitle ?? params.translate('connectedServices.authModal.nativeAuthSubtitle'),
            accessibilityLabel: resolveServiceOptionAccessibilityLabel({ serviceTitle, optionLabel: nativeLabel }),
            icon: params.renderSelectionIcon({
                selected: nativeSelected,
                variant: nativeAvailability.disabled ? 'warning' : 'default',
            }),
            disabled: nativeAvailability.disabled === true,
            onSelect: () => params.setBindingForService(serviceId, { source: 'native' }),
        });

        if (selectableProfiles.length === 0) {
            const connectLabel = params.translate('connectedServices.authModal.notConnectedTitle');
            options.push({
                id: createConnectServiceOptionId(serviceId),
                label: connectLabel,
                subtitle: params.translate('connectedServices.authModal.notConnectedSubtitle'),
                accessibilityLabel: resolveServiceOptionAccessibilityLabel({ serviceTitle, optionLabel: connectLabel }),
                icon: params.renderSettingsIcon(),
                onSelect: () => params.onOpenSettings(serviceId),
            });
        }

        return {
            kind: 'static',
            id: `connected-service:${serviceId}`,
            title: serviceTitle,
            options,
        };
    });

    return {
        rootStep: {
            id: 'new-session-connected-services-root',
            title: params.translate('connectedServices.title'),
            sections,
        },
        selectedOptionId: firstSelectedOptionId,
    };
}
