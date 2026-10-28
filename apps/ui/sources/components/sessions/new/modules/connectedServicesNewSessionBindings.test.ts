import { describe, expect, it } from 'vitest';

import { AGENTS_CORE } from '@happier-dev/agents';
import { AccountProfileSchema } from '@happier-dev/protocol';
import {
    buildConnectedServiceAccountGroupOptionsByServiceId,
    buildConnectedServiceProfileOptionsByServiceId,
    buildConnectedServicesBindingsPayload,
    resolveNewSessionConnectedServicesBindingsForAgent,
    type ConnectedServicesProfileOptionsByServiceId,
} from './connectedServicesNewSessionBindings';

const profileOptionsByServiceId: ConnectedServicesProfileOptionsByServiceId = {
    'openai-codex': [
        { profileId: 'work', status: 'connected', providerEmail: 'work@example.com' },
        { profileId: 'backup', status: 'connected', providerEmail: 'backup@example.com' },
    ],
};

describe('Antigravity saved default selection', () => {
    it('uses the additive exact account default and preserves explicit native choice', () => {
        const params = {
            agentId: 'agy', agentCore: AGENTS_CORE.agy,
            accountProfileConnectedServicesV2: AccountProfileSchema.shape.connectedServicesV2.parse([{ serviceId: 'antigravity',
                profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth' }] }]),
            settings: {
                connectedServicesProfileLabelByKey: {}, connectedServicesDefaultProfileByServiceId: {},
                connectedServicesAdditionalDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {
                    agy: { v: 1, bindingsByServiceId: { antigravity: { source: 'connected', profileId: 'work' } } },
                } },
            },
            connectedServicesFeatureEnabled: true, accountGroupsFeatureEnabled: true,
        };
        const saved = resolveNewSessionConnectedServicesBindingsForAgent({ ...params, agentOptionState: null });
        expect(saved.connectedServicesBindingsPayload?.bindingsByServiceId.antigravity)
            .toMatchObject({ source: 'connected', selection: 'profile', profileId: 'work' });
        const native = resolveNewSessionConnectedServicesBindingsForAgent({ ...params, agentOptionState: {
            connectedServicesBindingsByServiceId: { antigravity: { source: 'native' } },
        } });
        expect(native.connectedServicesBindingsPayload?.bindingsByServiceId.antigravity).toEqual({ source: 'native' });
    });
});

describe('buildConnectedServicesBindingsPayload', () => {
    it('emits a group binding without using the stored fallback profile id', () => {
        const payload = buildConnectedServicesBindingsPayload({
            supportedConnectedServiceIds: ['openai-codex'],
            connectedServiceProfileOptionsByServiceId: profileOptionsByServiceId,
            accountGroupsFeatureEnabled: true,
            connectedServiceAccountGroupOptionsByServiceId: {
                'openai-codex': [{
                    groupId: 'codex-main',
                    label: 'Codex main',
                    activeProfileId: 'backup',
                    enabledMemberCount: 2,
                    autoSwitch: true,
                    status: 'ready',
                }],
            },
            connectedServicesBindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'codex-main',
                    profileId: 'work',
                },
            },
            defaultProfileByServiceId: {},
        });

        expect(payload).toEqual({
            v: 1,
            bindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'codex-main',
                },
            },
        });
    });

    it('preserves a viable group binding when the active member needs reauth but another member is connected', () => {
        const payload = buildConnectedServicesBindingsPayload({
            supportedConnectedServiceIds: ['openai-codex'],
            connectedServiceProfileOptionsByServiceId: {
                'openai-codex': [
                    { profileId: 'work', status: 'needs_reauth', providerEmail: 'work@example.com' },
                    { profileId: 'backup', status: 'connected', providerEmail: 'backup@example.com' },
                ],
            },
            accountGroupsFeatureEnabled: true,
            connectedServiceAccountGroupOptionsByServiceId: {
                'openai-codex': [{
                    groupId: 'codex-main',
                    label: 'Codex main',
                    activeProfileId: 'work',
                    memberProfileIds: ['work', 'backup'],
                    enabledMemberCount: 2,
                    autoSwitch: true,
                    status: 'ready',
                }],
            },
            connectedServicesBindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'codex-main',
                    profileId: 'work',
                },
            },
            defaultProfileByServiceId: {},
        });

        expect(payload).toEqual({
            v: 1,
            bindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'codex-main',
                },
            },
        });
    });

    it('preserves a missing explicit group binding instead of silently selecting native auth', () => {
        const payload = buildConnectedServicesBindingsPayload({
            supportedConnectedServiceIds: ['openai-codex'],
            connectedServiceProfileOptionsByServiceId: profileOptionsByServiceId,
            accountGroupsFeatureEnabled: true,
            connectedServiceAccountGroupOptionsByServiceId: {
                'openai-codex': [{
                    groupId: 'codex-main',
                    label: 'Codex main',
                    activeProfileId: 'work',
                    enabledMemberCount: 2,
                    autoSwitch: true,
                    status: 'ready',
                }],
            },
            connectedServicesBindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'missing-group',
                    profileId: 'missing',
                },
            },
            defaultProfileByServiceId: { 'openai-codex': 'backup' },
        });

        expect(payload).toEqual({
            v: 1,
            bindingsByServiceId: {
                'openai-codex': { source: 'connected', selection: 'group', groupId: 'missing-group' },
            },
        });
    });

    it('preserves explicit group intent when the target server cannot currently use account groups', () => {
        const payload = buildConnectedServicesBindingsPayload({
            supportedConnectedServiceIds: ['openai-codex'],
            connectedServiceProfileOptionsByServiceId: profileOptionsByServiceId,
            accountGroupsFeatureEnabled: false,
            connectedServiceAccountGroupOptionsByServiceId: {
                'openai-codex': [{
                    groupId: 'codex-main',
                    label: 'Codex main',
                    activeProfileId: 'work',
                    enabledMemberCount: 2,
                    autoSwitch: true,
                    status: 'ready',
                }],
            },
            connectedServicesBindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'codex-main',
                    profileId: 'work',
                },
            },
            defaultProfileByServiceId: {},
        });

        expect(payload).toEqual({
            v: 1,
            bindingsByServiceId: {
                'openai-codex': { source: 'connected', selection: 'group', groupId: 'codex-main' },
            },
        });
    });

    it('preserves explicit group intent when the target runtime cannot currently switch account groups', () => {
        const payload = buildConnectedServicesBindingsPayload({
            supportedConnectedServiceIds: ['openai-codex'],
            connectedServiceProfileOptionsByServiceId: profileOptionsByServiceId,
            accountGroupsFeatureEnabled: true,
            accountGroupSwitchingEnabled: false,
            connectedServiceAccountGroupOptionsByServiceId: {
                'openai-codex': [{
                    groupId: 'codex-main',
                    label: 'Codex main',
                    activeProfileId: 'work',
                    enabledMemberCount: 2,
                    autoSwitch: true,
                    status: 'ready',
                }],
            },
            connectedServicesBindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'codex-main',
                    profileId: 'work',
                },
            },
            defaultProfileByServiceId: {},
        });

        expect(payload).toEqual({
            v: 1,
            bindingsByServiceId: {
                'openai-codex': { source: 'connected', selection: 'group', groupId: 'codex-main' },
            },
        });
    });
});

describe('buildConnectedServiceProfileOptionsByServiceId', () => {
    it('preserves unsupported-kind projection and UI subtitle keys for a fixed agent fixture', () => {
        const options = buildConnectedServiceProfileOptionsByServiceId({
            accountProfileConnectedServicesV2: [{
                serviceId: 'claude-subscription',
                profiles: [
                    {
                        profileId: 'oauth-not-supported',
                        status: 'connected',
                        kind: 'oauth',
                        providerEmail: 'oauth@example.com',
                    },
                ],
            }],
            agentCore: {
                id: 'test-agent',
                connectedServices: {
                    supportedServiceIds: ['claude-subscription'],
                    supportedKindsByServiceId: {
                        'claude-subscription': ['token'],
                    },
                },
            },
            supportedConnectedServiceIds: ['claude-subscription'],
            labelsByKey: {},
        });

        expect(options['claude-subscription']).toEqual([
            expect.objectContaining({
                profileId: 'oauth-not-supported',
                status: 'unsupported_kind',
                kind: 'oauth',
                unsupportedSubtitleKey: 'connectedServices.detail.connectSetupTokenSubtitle',
            }),
        ]);
    });

    it('projects Claude subscription OAuth profiles as selectable for both Pi and OpenCode', () => {
        const accountProfileConnectedServicesV2 = [{
            serviceId: 'claude-subscription' as const,
            profiles: [
                {
                    profileId: 'claude-pro-oauth',
                    status: 'connected',
                    kind: 'oauth' as const,
                    providerEmail: 'oauth@example.com',
                },
            ],
        }];

        const piOptions = buildConnectedServiceProfileOptionsByServiceId({
            accountProfileConnectedServicesV2,
            agentCore: AGENTS_CORE.pi,
            supportedConnectedServiceIds: AGENTS_CORE.pi.connectedServices?.supportedServiceIds ?? [],
            labelsByKey: {},
        });
        const opencodeOptions = buildConnectedServiceProfileOptionsByServiceId({
            accountProfileConnectedServicesV2,
            agentCore: AGENTS_CORE.opencode,
            supportedConnectedServiceIds: AGENTS_CORE.opencode.connectedServices?.supportedServiceIds ?? [],
            labelsByKey: {},
        });

        expect(piOptions['claude-subscription']).toEqual([
            expect.objectContaining({
                profileId: 'claude-pro-oauth',
                status: 'connected',
                kind: 'oauth',
            }),
        ]);
        expect(opencodeOptions['claude-subscription']).toEqual([
            expect.objectContaining({
                profileId: 'claude-pro-oauth',
                status: 'connected',
                kind: 'oauth',
            }),
        ]);

        for (const options of [piOptions, opencodeOptions]) {
            expect(buildConnectedServicesBindingsPayload({
                supportedConnectedServiceIds: ['claude-subscription'],
                connectedServiceProfileOptionsByServiceId: options,
                connectedServicesBindingsByServiceId: {
                    'claude-subscription': {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'claude-pro-oauth',
                    },
                },
                defaultProfileByServiceId: {},
            })).toEqual({
                v: 1,
                bindingsByServiceId: {
                    'claude-subscription': {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'claude-pro-oauth',
                    },
                },
            });
        }
    });

    it('projects OpenCode Claude subscription setup-token AND OAuth profiles as selectable', () => {
        const options = buildConnectedServiceProfileOptionsByServiceId({
            accountProfileConnectedServicesV2: [{
                serviceId: 'claude-subscription',
                profiles: [
                    {
                        profileId: 'claude-pro-token',
                        status: 'connected',
                        kind: 'token',
                        providerEmail: 'token@example.com',
                    },
                    {
                        profileId: 'claude-pro-oauth',
                        status: 'connected',
                        kind: 'oauth',
                        providerEmail: 'oauth@example.com',
                    },
                ],
            }],
            agentCore: AGENTS_CORE.opencode,
            supportedConnectedServiceIds: AGENTS_CORE.opencode.connectedServices?.supportedServiceIds ?? [],
            labelsByKey: {},
        });

        expect(options['claude-subscription']).toEqual([
            expect.objectContaining({
                profileId: 'claude-pro-token',
                status: 'connected',
                kind: 'token',
            }),
            expect.objectContaining({
                profileId: 'claude-pro-oauth',
                status: 'connected',
                kind: 'oauth',
            }),
        ]);
    });
});

describe('buildConnectedServiceAccountGroupOptionsByServiceId', () => {
    it('does not expose account-group options when account groups are disabled', () => {
        const options = buildConnectedServiceAccountGroupOptionsByServiceId({
            accountGroupsFeatureEnabled: false,
            accountProfileConnectedServicesV2: [{
                serviceId: 'openai-codex',
                groups: [{
                    groupId: 'codex-main',
                    displayName: 'Codex main',
                    activeProfileId: 'work',
                    members: [{ profileId: 'work', enabled: true }],
                }],
            }],
            supportedConnectedServiceIds: ['openai-codex'],
        });

        expect(options).toEqual({});
    });

    it('counts profile ids projected by the account profile API as enabled group members', () => {
        const options = buildConnectedServiceAccountGroupOptionsByServiceId({
            accountGroupsFeatureEnabled: true,
            accountProfileConnectedServicesV2: [{
                serviceId: 'openai-codex',
                groups: [{
                    groupId: 'codex-main',
                    displayName: 'Codex main',
                    activeProfileId: 'work',
                    memberProfileIds: ['work', 'backup'],
                }],
            }],
            supportedConnectedServiceIds: ['openai-codex'],
        });

        expect(options['openai-codex']).toEqual([expect.objectContaining({
            groupId: 'codex-main',
            enabledMemberCount: 2,
            status: 'ready',
        })]);
    });

    it('prefers state.status when projecting exhausted account groups', () => {
        const options = buildConnectedServiceAccountGroupOptionsByServiceId({
            accountGroupsFeatureEnabled: true,
            accountProfileConnectedServicesV2: [{
                serviceId: 'openai-codex',
                groups: [{
                    groupId: 'codex-main',
                    displayName: 'Codex main',
                    activeProfileId: 'work',
                    memberProfileIds: ['work', 'backup'],
                    state: {
                        status: 'exhausted',
                    },
                }],
            }],
            supportedConnectedServiceIds: ['openai-codex'],
        });

        expect(options['openai-codex']).toEqual([expect.objectContaining({
            groupId: 'codex-main',
            enabledMemberCount: 2,
            status: 'exhausted',
        })]);
    });
});
