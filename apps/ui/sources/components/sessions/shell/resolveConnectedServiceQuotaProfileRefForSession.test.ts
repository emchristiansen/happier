import { AccountProfileSchema } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { resolveConnectedServiceQuotaProfileRefForSession } from './resolveConnectedServiceQuotaProfileRefForSession';

describe('resolveConnectedServiceQuotaProfileRefForSession', () => {
    it('ignores legacy session quota refs when a native session has no connected-service binding', () => {
        expect(resolveConnectedServiceQuotaProfileRefForSession({
            agentId: 'codex',
            accountProfileConnectedServicesV2: [],
            metadata: {
                path: '/tmp/project',
                host: 'local',
                connectedServiceQuotaRefsV1: {
                    v: 1,
                    refs: [{
                        v: 1,
                        serviceId: 'openai-codex',
                        profileId: 'acct:native-codex',
                    }],
                    updatedAtMs: 1_000,
                },
            },
        })).toBeNull();
    });

    it('keeps connected-service bindings ahead of native quota refs', () => {
        expect(resolveConnectedServiceQuotaProfileRefForSession({
            agentId: 'codex',
            accountProfileConnectedServicesV2: [],
            metadata: {
                path: '/tmp/project',
                host: 'local',
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        'openai-codex': {
                            source: 'connected',
                            profileId: 'connected-profile',
                        },
                    },
                },
                connectedServiceQuotaRefsV1: {
                    v: 1,
                    refs: [{
                        v: 1,
                        serviceId: 'openai-codex',
                        profileId: 'acct:native-codex',
                    }],
                    updatedAtMs: 1_000,
                },
            },
        })).toEqual({
            serviceId: 'openai-codex',
            profileId: 'connected-profile',
            provenance: 'connected_binding_profile',
        });
    });

    it('carries explicit profile credential health so quota consumers can suppress stale invalid snapshots', () => {
        const accountProfileConnectedServicesV2 = AccountProfileSchema.parse({
            id: 'acct',
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [
                    { profileId: 'connected-profile', status: 'needs_reauth', kind: 'oauth', providerEmail: 'a@b.com', expiresAt: 1 },
                ],
                groups: [],
            }],
        }).connectedServicesV2;

        expect(resolveConnectedServiceQuotaProfileRefForSession({
            agentId: 'codex',
            accountProfileConnectedServicesV2,
            metadata: {
                path: '/tmp/project',
                host: 'local',
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        'openai-codex': {
                            source: 'connected',
                            profileId: 'connected-profile',
                        },
                    },
                },
            },
        })).toEqual({
            serviceId: 'openai-codex',
            profileId: 'connected-profile',
            credentialHealthStatus: 'needs_reauth',
            provenance: 'connected_binding_profile',
        });
    });

    it('reports group provenance for group bindings resolved to the active member', () => {
        const accountProfileConnectedServicesV2 = AccountProfileSchema.parse({
            id: 'acct',
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [
                    { profileId: 'member-a', status: 'connected', kind: 'oauth', providerEmail: 'a@b.com', expiresAt: 1 },
                ],
                groups: [{
                    groupId: 'codex-main',
                    displayName: 'Codex main',
                    activeProfileId: 'member-a',
                    generation: 1,
                    memberProfileIds: ['member-a'],
                }],
            }],
        }).connectedServicesV2;
        expect(resolveConnectedServiceQuotaProfileRefForSession({
            agentId: 'codex',
            accountProfileConnectedServicesV2,
            metadata: {
                path: '/tmp/project',
                host: 'local',
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        'openai-codex': {
                            source: 'connected',
                            selection: 'group',
                            groupId: 'codex-main',
                        },
                    },
                },
            },
        })).toEqual({
            serviceId: 'openai-codex',
            profileId: 'member-a',
            groupId: 'codex-main',
            credentialHealthStatus: 'connected',
            provenance: 'connected_binding_group',
        });
    });

    it('resolves group provenance through retryable refresh-failure members', () => {
        const accountProfileConnectedServicesV2 = AccountProfileSchema.parse({
            id: 'acct',
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [
                    { profileId: 'member-a', status: 'refresh_failed_retryable', kind: 'oauth', providerEmail: 'a@b.com', expiresAt: 1 },
                ],
                groups: [{
                    groupId: 'codex-main',
                    displayName: 'Codex main',
                    activeProfileId: 'member-a',
                    generation: 1,
                    memberProfileIds: ['member-a'],
                }],
            }],
        }).connectedServicesV2;

        expect(resolveConnectedServiceQuotaProfileRefForSession({
            agentId: 'codex',
            accountProfileConnectedServicesV2,
            metadata: {
                path: '/tmp/project',
                host: 'local',
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        'openai-codex': {
                            source: 'connected',
                            selection: 'group',
                            groupId: 'codex-main',
                        },
                    },
                },
            },
        })).toEqual({
            serviceId: 'openai-codex',
            profileId: 'member-a',
            groupId: 'codex-main',
            credentialHealthStatus: 'refresh_failed_retryable',
            provenance: 'connected_binding_group',
        });
    });
});
