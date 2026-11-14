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

describe('per-session pool "Start on" through the normal producer and creation normalizer (HPI-11)', () => {
    const base = {
        agentId: 'claude', agentCore: AGENTS_CORE.claude,
        accountProfileConnectedServicesV2: AccountProfileSchema.shape.connectedServicesV2.parse([{
            serviceId: 'claude-subscription',
            profiles: [
                { profileId: 'work', status: 'connected', kind: 'oauth' },
                { profileId: 'home', status: 'connected', kind: 'oauth' },
            ],
            groups: [{ groupId: 'pool', activeProfileId: 'work', memberProfileIds: ['work', 'home'] }],
        }]),
        settings: { connectedServicesProfileLabelByKey: {}, connectedServicesDefaultProfileByServiceId: {} },
        connectedServicesFeatureEnabled: true, accountGroupsFeatureEnabled: true,
        agentOptionState: { connectedServicesBindingsByServiceId: { 'claude-subscription': {
            source: 'connected', selection: 'group', groupId: 'pool', initialProfileId: 'home',
        } } },
    };
    const authoritativeGroup = {
        v: 1, serviceId: 'claude-subscription', groupId: 'pool', displayName: 'Pool', activeProfileId: 'work', generation: 1,
        runtimeStateRevision: 0, policy: { v: 1, strategy: 'per_session_softmax', autoSwitch: true }, state: { v: 1 },
        members: [
            { v: 1, serviceId: 'claude-subscription', groupId: 'pool', profileId: 'work', enabled: true, priority: 1, state: { v: 1 }, createdAt: 1, updatedAt: 1 },
            { v: 1, serviceId: 'claude-subscription', groupId: 'pool', profileId: 'home', enabled: true, priority: 2, state: { v: 1 }, createdAt: 1, updatedAt: 1 },
        ],
        createdAt: 1, updatedAt: 1,
    };

    it('marks the pool per-session only with the authoritative group, and the explicit start survives creation normalization', async () => {
        const { normalizeSessionAuthoringConnectedServices, normalizeInheritedSessionAuthoringConnectedServices } =
            await import('@/sync/domains/sessionAuthoring/sessionAuthoringNormalization');
        const withoutGroups = resolveNewSessionConnectedServicesBindingsForAgent(base as never);
        expect(withoutGroups.connectedServiceAccountGroupOptionsByServiceId['claude-subscription']?.[0]?.assignment).not.toBe('per_session');

        const resolved = resolveNewSessionConnectedServicesBindingsForAgent({
            ...base, accountGroupsByServiceId: { 'claude-subscription': [authoritativeGroup] },
        } as never);
        expect(resolved.connectedServiceAccountGroupOptionsByServiceId['claude-subscription']?.[0])
            .toMatchObject({ groupId: 'pool', assignment: 'per_session' });
        const payload = resolved.connectedServicesBindingsPayload;
        expect(payload?.bindingsByServiceId['claude-subscription']).toMatchObject({ selection: 'group', groupId: 'pool', initialProfileId: 'home' });

        const created = normalizeSessionAuthoringConnectedServices(payload) as { bindingsByServiceId: Record<string, Record<string, unknown>> };
        expect(created.bindingsByServiceId['claude-subscription']).toMatchObject({ groupId: 'pool', initialProfileId: 'home' });

        const forged = normalizeSessionAuthoringConnectedServices({ v: 1, bindingsByServiceId: { 'claude-subscription': {
            source: 'connected', selection: 'group', groupId: 'pool', initialProfileId: 'home',
            member: { assignment: 'per_session', profileId: 'home', decisionId: 'd', reason: 'initial_requested', appliedAtMs: 1 },
        } } }) as { bindingsByServiceId: Record<string, Record<string, unknown>> };
        expect(forged.bindingsByServiceId['claude-subscription']).toEqual({ source: 'connected', selection: 'group', groupId: 'pool', initialProfileId: 'home' });

        const inherited = normalizeInheritedSessionAuthoringConnectedServices(payload) as { bindingsByServiceId: Record<string, Record<string, unknown>> };
        expect(inherited.bindingsByServiceId['claude-subscription']).toEqual({ source: 'connected', selection: 'group', groupId: 'pool' });
    });
});
