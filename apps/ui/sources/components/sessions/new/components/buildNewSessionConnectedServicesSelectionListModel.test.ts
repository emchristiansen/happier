import { describe, expect, it, vi } from 'vitest';

import {
    buildNewSessionConnectedServicesSelectionListModel,
    createConnectedServiceOptionId,
    createConnectedServiceGroupOptionId,
    createNativeServiceOptionId,
    createReauthServiceOptionId,
    type ConnectedServicesSelectionOptionAvailability,
    type NewSessionConnectedServicesSelectionListModel,
} from './buildNewSessionConnectedServicesSelectionListModel';

function firstStaticSection(model: NewSessionConnectedServicesSelectionListModel) {
    const section = model.rootStep.sections[0];
    if (!section || section.kind !== 'static') {
        throw new Error('Expected a static connected service section');
    }
    return section;
}

function buildModel(overrides: Partial<Parameters<typeof buildNewSessionConnectedServicesSelectionListModel>[0]> = {}) {
    return buildNewSessionConnectedServicesSelectionListModel({
        supportedServiceIds: ['anthropic'],
        profileOptionsByServiceId: {
            anthropic: [{ profileId: 'work', status: 'connected', providerEmail: 'work@example.com' }],
        },
        bindingsByServiceId: { anthropic: { source: 'native' } },
        quotaBadgesByKey: {},
        setBindingForService: vi.fn(),
        onOpenSettings: vi.fn(),
        translate: (key: string, params?: { member?: string }) =>
            key === 'connectedServices.detail.groups.activeMember'
                ? `Active ${params?.member ?? ''}`
                : key,
        resolveServiceTitle: (serviceId) => `service:${serviceId}`,
        renderSelectionIcon: ({ selected }) => selected ? 'selected-icon' : 'unselected-icon',
        renderSettingsIcon: () => 'settings-icon',
        renderQuotaBadges: (badges) => `badges:${badges.map((badge) => badge.text).join(',')}`,
        renderNeedsReauthPill: () => 'needs-reauth',
        ...overrides,
    });
}

describe('buildNewSessionConnectedServicesSelectionListModel', () => {
    it('puts connected account rows first and binds the selected account directly', () => {
        const setBindingForService = vi.fn();
        const model = buildModel({ setBindingForService });

        const accountOption = firstStaticSection(model).options[0];
        expect(accountOption).toEqual(expect.objectContaining({
            id: createConnectedServiceOptionId('anthropic', 'work'),
            label: 'work@example.com',
            subtitle: 'work',
        }));

        accountOption?.onSelect?.();

        expect(setBindingForService).toHaveBeenCalledWith('anthropic', { source: 'connected', selection: 'profile', profileId: 'work' });
    });

    it('keeps local CLI auth as the fallback row for each supported service', () => {
        const setBindingForService = vi.fn();
        const model = buildModel({
            bindingsByServiceId: { anthropic: { source: 'connected', selection: 'profile', profileId: 'work' } },
            setBindingForService,
        });

        const nativeOption = firstStaticSection(model).options.find((option) => option.id === createNativeServiceOptionId('anthropic'));
        nativeOption?.onSelect?.();

        expect(nativeOption).toEqual(expect.objectContaining({
            label: 'connectedServices.authModal.nativeAuthTitle',
            subtitle: 'connectedServices.authModal.nativeAuthSubtitle',
        }));
        expect(setBindingForService).toHaveBeenCalledWith('anthropic', { source: 'native' });
    });

    it('marks native auth unavailable when continuity validation disables it', () => {
        const model = buildModel({
            bindingsByServiceId: { anthropic: { source: 'connected', selection: 'profile', profileId: 'work' } },
            resolveOptionAvailability: ({ optionId }): ConnectedServicesSelectionOptionAvailability => (
                optionId === createNativeServiceOptionId('anthropic')
                    ? { disabled: true, subtitle: 'Session state sharing is required.' }
                    : {}
            ),
        });

        const nativeOption = firstStaticSection(model).options.find((option) => option.id === createNativeServiceOptionId('anthropic'));

        expect(nativeOption).toEqual(expect.objectContaining({
            id: createNativeServiceOptionId('anthropic'),
            disabled: true,
            subtitle: 'Session state sharing is required.',
        }));
    });

    it('routes unavailable connected accounts to settings instead of selecting an invalid profile', () => {
        const setBindingForService = vi.fn();
        const onOpenSettings = vi.fn();
        const model = buildModel({
            profileOptionsByServiceId: {
                anthropic: [{ profileId: 'work', status: 'needs_reauth', providerEmail: 'work@example.com' }],
            },
            setBindingForService,
            onOpenSettings,
        });

        const reauthOption = firstStaticSection(model).options.find((option) => option.id === createReauthServiceOptionId('anthropic', 'work'));
        reauthOption?.onSelect?.();

        expect(reauthOption).toEqual(expect.objectContaining({
            rightAccessory: 'needs-reauth',
        }));
        expect(setBindingForService).not.toHaveBeenCalled();
        expect(onOpenSettings).toHaveBeenCalledWith('anthropic');
    });

    it('shows unsupported connected account kinds as action-required rows', () => {
        const setBindingForService = vi.fn();
        const onOpenSettings = vi.fn();
        const model = buildModel({
            profileOptionsByServiceId: {
                anthropic: [{
                    profileId: 'oauth-work',
                    status: 'unsupported_kind',
                    kind: 'oauth',
                    providerEmail: 'oauth@example.com',
                    unsupportedSubtitleKey: 'connectedServices.detail.connectSetupTokenSubtitle',
                }],
            },
            setBindingForService,
            onOpenSettings,
        });

        const unsupportedOption = firstStaticSection(model).options.find((option) =>
            option.id === createReauthServiceOptionId('anthropic', 'oauth-work'));
        unsupportedOption?.onSelect?.();

        expect(unsupportedOption).toEqual(expect.objectContaining({
            subtitle: 'connectedServices.detail.connectSetupTokenSubtitle',
            rightAccessory: 'needs-reauth',
        }));
        expect(setBindingForService).not.toHaveBeenCalled();
        expect(onOpenSettings).toHaveBeenCalledWith('anthropic');
    });

    it('adds quota accessories to connected account rows', () => {
        const model = buildModel({
            bindingsByServiceId: { anthropic: { source: 'connected', selection: 'profile', profileId: 'work' } },
            quotaBadgesByKey: {
                'anthropic/work': [{ meterId: 'weekly', text: 'w. 18%' }],
            },
        });

        const accountOption = firstStaticSection(model).options[0];

        expect(model.selectedOptionId).toBe(createConnectedServiceOptionId('anthropic', 'work'));
        expect(accountOption?.rightAccessory).toBe('badges:w. 18%');
    });

    it('keeps retryable refresh-failure profiles selectable instead of routing them to reconnect', () => {
        const setBindingForService = vi.fn();
        const model = buildModel({
            profileOptionsByServiceId: {
                anthropic: [{
                    profileId: 'retryable',
                    status: 'refresh_failed_retryable',
                    providerEmail: 'retryable@example.com',
                }],
            },
            bindingsByServiceId: { anthropic: { source: 'native' } },
            quotaBadgesByKey: {
                'anthropic/retryable': [{ meterId: 'weekly', text: 'w. 44%' }],
            },
            setBindingForService,
            renderSelectionIcon: ({ selected, variant }) => `${selected ? 'selected' : 'unselected'}:${variant ?? 'default'}`,
        });

        const accountOption = firstStaticSection(model).options[0];
        accountOption?.onSelect?.();

        expect(accountOption).toEqual(expect.objectContaining({
            id: createConnectedServiceOptionId('anthropic', 'retryable'),
            icon: 'unselected:warning',
            rightAccessory: 'badges:w. 44%',
        }));
        expect(setBindingForService).toHaveBeenCalledWith('anthropic', {
            source: 'connected',
            selection: 'profile',
            profileId: 'retryable',
        });
    });

    it('offers connected account groups as a distinct auth selection without storing a fallback profile id', () => {
        const setBindingForService = vi.fn();
        const model = buildModel({
            setBindingForService,
            bindingsByServiceId: {
                anthropic: {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'primary',
                    profileId: 'work',
                } as any,
            },
            accountGroupOptionsByServiceId: {
                anthropic: [{
                    groupId: 'primary',
                    label: 'Primary pool',
                    activeProfileId: 'work',
                    enabledMemberCount: 2,
                    autoSwitch: true,
                    status: 'ready',
                }],
            },
        } as any);

        const groupOptionId = 'connected-service:anthropic:group:primary';
        const groupOption = firstStaticSection(model).options.find((option) =>
            option.id === groupOptionId);
        groupOption?.onSelect?.();

        expect(model.selectedOptionId).toBe(groupOptionId);
        expect(groupOption).toEqual(expect.objectContaining({
            label: 'Primary pool',
            subtitle: 'Active work@example.com · work',
        }));
        expect(setBindingForService).toHaveBeenCalledWith('anthropic', {
            source: 'connected',
            selection: 'group',
            groupId: 'primary',
        });
    });

    it('adds quota accessories to connected account group rows from the viable active profile', () => {
        const model = buildModel({
            bindingsByServiceId: {
                anthropic: { source: 'connected', selection: 'group', groupId: 'primary' } as any,
            },
            accountGroupOptionsByServiceId: {
                anthropic: [{
                    groupId: 'primary',
                    label: 'Primary pool',
                    activeProfileId: 'work',
                    enabledMemberCount: 2,
                    autoSwitch: true,
                    status: 'ready',
                }],
            },
            quotaBadgesByKey: {
                'anthropic/work': [{ meterId: 'weekly', text: '8%' }],
            },
        } as any);

        const groupOption = firstStaticSection(model).options.find((option) =>
            option.id === 'connected-service:anthropic:group:primary');

        expect(groupOption?.rightAccessory).toBe('badges:8%');
    });

    it('shows the active member identity in connected account group subtitles', () => {
        const model = buildModel({
            profileOptionsByServiceId: {
                anthropic: [{
                    profileId: 'work',
                    status: 'connected',
                    label: 'Work account',
                    providerEmail: 'work@example.com',
                }],
            },
            accountGroupOptionsByServiceId: {
                anthropic: [{
                    groupId: 'primary',
                    label: 'Primary pool',
                    activeProfileId: 'work',
                    memberProfileIds: ['work'],
                    enabledMemberCount: 1,
                    autoSwitch: true,
                    status: 'ready',
                }],
            },
        });

        const groupOption = firstStaticSection(model).options.find((option) =>
            option.id === createConnectedServiceGroupOptionId('anthropic', 'primary'));

        expect(groupOption?.subtitle).toBe('Active Work account · work@example.com · work');
    });

    it('keeps a group option selected when the group active profile changed after the binding was stored', () => {
        const model = buildModel({
            bindingsByServiceId: {
                anthropic: {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'primary',
                    profileId: 'stale',
                } as any,
            },
            accountGroupOptionsByServiceId: {
                anthropic: [{
                    groupId: 'primary',
                    label: 'Primary pool',
                    activeProfileId: 'work',
                    enabledMemberCount: 2,
                    autoSwitch: true,
                    status: 'ready',
                }],
            },
        } as any);

        expect(model.selectedOptionId).toBe('connected-service:anthropic:group:primary');
    });

    it('shows and preserves a group binding when the active member needs reauth but another member is connected', () => {
        const setBindingForService = vi.fn();
        const model = buildModel({
            setBindingForService,
            profileOptionsByServiceId: {
                anthropic: [
                    { profileId: 'work', status: 'needs_reauth', providerEmail: 'work@example.com' },
                    { profileId: 'backup', status: 'connected', providerEmail: 'backup@example.com' },
                ],
            },
            bindingsByServiceId: {
                anthropic: {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'primary',
                    profileId: 'work',
                },
            },
            accountGroupOptionsByServiceId: {
                anthropic: [{
                    groupId: 'primary',
                    label: 'Primary pool',
                    activeProfileId: 'work',
                    memberProfileIds: ['work', 'backup'],
                    enabledMemberCount: 2,
                    autoSwitch: true,
                    status: 'ready',
                }],
            },
        });

        const groupOptionId = 'connected-service:anthropic:group:primary';
        const groupOption = firstStaticSection(model).options.find((option) =>
            option.id === groupOptionId);
        groupOption?.onSelect?.();

        expect(model.selectedOptionId).toBe(groupOptionId);
        expect(groupOption).toEqual(expect.objectContaining({
            label: 'Primary pool',
            subtitle: 'Active work@example.com · work',
        }));
        expect(setBindingForService).toHaveBeenCalledWith('anthropic', {
            source: 'connected',
            selection: 'group',
            groupId: 'primary',
        });
    });

    it('selects native auth when a stored group default no longer resolves', () => {
        const model = buildModel({
            bindingsByServiceId: {
                anthropic: {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'missing',
                },
            },
            defaultProfileIdByServiceId: { anthropic: 'work' },
        });

        expect(model.selectedOptionId).toBe(createNativeServiceOptionId('anthropic'));
    });

    it('keeps a stored group default visible and disabled when it is not ready', () => {
        const model = buildModel({
            bindingsByServiceId: {
                anthropic: {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'primary',
                },
            },
            accountGroupOptionsByServiceId: {
                anthropic: [{
                    groupId: 'primary',
                    label: 'Primary pool',
                    activeProfileId: 'work',
                    enabledMemberCount: 2,
                    autoSwitch: true,
                    status: 'exhausted',
                }],
            },
        });

        const groupOptionId = createConnectedServiceGroupOptionId('anthropic', 'primary');
        const groupOption = firstStaticSection(model).options.find((option) => option.id === groupOptionId);

        expect(model.selectedOptionId).toBe(groupOptionId);
        expect(groupOption).toEqual(expect.objectContaining({
            disabled: true,
            subtitle: 'connectedServices.authModal.groupExhaustedSubtitle',
        }));
    });

    it('marks switch options unavailable when continuity validation disables them', () => {
        const model = buildModel({
            resolveOptionAvailability: ({ optionId }): ConnectedServicesSelectionOptionAvailability => (
                optionId === createConnectedServiceOptionId('anthropic', 'work')
                    ? { disabled: true, subtitle: 'Session state sharing is required.' }
                    : {}
            ),
        });

        const accountOption = firstStaticSection(model).options[0];

        expect(accountOption).toEqual(expect.objectContaining({
            id: createConnectedServiceOptionId('anthropic', 'work'),
            disabled: true,
            subtitle: 'Session state sharing is required.',
        }));
    });

    it('qualifies repeated service fallback rows for assistive technology', () => {
        const model = buildModel({
            supportedServiceIds: ['anthropic', 'openai-codex'],
            profileOptionsByServiceId: {
                anthropic: [],
                'openai-codex': [],
            },
            bindingsByServiceId: {
                anthropic: { source: 'native' },
                'openai-codex': { source: 'native' },
            },
        });

        const nativeRows = model.rootStep.sections
            .flatMap((section) => section.kind === 'static' ? section.options : [])
            .filter((option) => option.id.endsWith(':native'))
            .map((option) => option as unknown as { accessibilityLabel?: string });
        const connectRows = model.rootStep.sections
            .flatMap((section) => section.kind === 'static' ? section.options : [])
            .filter((option) => option.id.endsWith(':connect'))
            .map((option) => option as unknown as { accessibilityLabel?: string });

        expect(nativeRows.map((option) => option.accessibilityLabel)).toEqual([
            'service:anthropic · connectedServices.authModal.nativeAuthTitle',
            'service:openai-codex · connectedServices.authModal.nativeAuthTitle',
        ]);
        expect(connectRows.map((option) => option.accessibilityLabel)).toEqual([
            'service:anthropic · connectedServices.authModal.notConnectedTitle',
            'service:openai-codex · connectedServices.authModal.notConnectedTitle',
        ]);
    });

    it('offers optional start-on members for a selected per-session pool and binds initialProfileId', () => {
        const setBindingForService = vi.fn();
        const group = {
            groupId: 'pool', label: 'Pool', activeProfileId: 'work', memberProfileIds: ['work', 'home'],
            enabledMemberCount: 2, autoSwitch: true, status: 'ready' as const,
            strategy: 'per_session_softmax', assignment: 'per_session' as const,
        };
        const model = buildModel({
            supportedServiceIds: ['claude-subscription'],
            profileOptionsByServiceId: {
                'claude-subscription': [
                    { profileId: 'work', status: 'connected', providerEmail: 'work@example.com' },
                    { profileId: 'home', status: 'connected', providerEmail: 'home@example.com' },
                ],
            },
            accountGroupOptionsByServiceId: { 'claude-subscription': [group] },
            bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool' } },
            setBindingForService,
        });
        const startOptions = firstStaticSection(model).options.filter((option) => option.id.includes(':start:'));
        expect(startOptions.map((option) => option.label)).toEqual([
            'connectedServices.authModal.startOnMember: work@example.com',
            'connectedServices.authModal.startOnMember: home@example.com',
        ]);
        startOptions[1]?.onSelect?.();
        expect(setBindingForService).toHaveBeenCalledWith('claude-subscription', {
            source: 'connected', selection: 'group', groupId: 'pool', initialProfileId: 'home',
        });
    });

    it('offers no start-on members for a shared pool', () => {
        const model = buildModel({
            supportedServiceIds: ['claude-subscription'],
            profileOptionsByServiceId: { 'claude-subscription': [{ profileId: 'work', status: 'connected' }] },
            accountGroupOptionsByServiceId: { 'claude-subscription': [{
                groupId: 'pool', label: 'Pool', activeProfileId: 'work', memberProfileIds: ['work'],
                enabledMemberCount: 1, autoSwitch: true, status: 'ready' as const, strategy: 'priority', assignment: 'shared' as const,
            }] },
            bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool' } },
        });
        expect(firstStaticSection(model).options.some((option) => option.id.includes(':start:'))).toBe(false);
    });
});

