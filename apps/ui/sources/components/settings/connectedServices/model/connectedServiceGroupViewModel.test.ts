import { describe, expect, it, vi } from 'vitest';

import { t } from '@/text';

import {
    formatConnectedServiceGroupMemberSubtitle,
    formatConnectedServiceGroupSubtitle,
    normalizeConnectedServiceGroupPolicy,
    normalizeConnectedServiceGroupMember,
    parseConnectedServiceGroupViewModels,
    resolveConnectedServiceGroupMemberIdentity,
    resolveConnectedServiceGroupProfileTitle,
} from './connectedServiceGroupViewModel';

describe('connectedServiceGroupViewModel', () => {
    it('preserves allowance selection while sanitizing unrelated legacy policy fields', () => {
        expect(normalizeConnectedServiceGroupPolicy({
            strategy: 'least_limited',
            autoSwitch: true,
            quotaLimitSelection: { mode: 'selected', providerLimitIds: ['spark'] },
            legacyUnknownField: true,
        })).toMatchObject({
            strategy: 'least_limited',
            autoSwitch: true,
            quotaLimitSelection: { mode: 'selected', providerLimitIds: ['spark'] },
        });
    });

    it('surfaces the automatic model-entitlement disable reason instead of a generic plan failure', () => {
        const member = normalizeConnectedServiceGroupMember({
            profileId: 'free-account',
            enabled: false,
            state: {
                lastFailureKind: 'plan',
                lastFailureCode: 'model_not_entitled',
                autoDisabledReason: 'model_not_entitled',
            },
        });
        expect(member).not.toBeNull();
        expect(formatConnectedServiceGroupMemberSubtitle(member!, null)).toContain(
            t('connectedServices.detail.groups.memberAutoDisabledModelNotEntitled'),
        );
    });
    it('normalizes legacy group projections into a stable group view model', () => {
        const [group] = parseConnectedServiceGroupViewModels([{
            groupId: 'primary',
            label: 'Primary pool',
            activeProfileId: 'work',
            strategy: 'manual',
            autoSwitch: true,
            generation: 4,
            state: { status: 'exhausted', cooldownUntilMs: 1_800_000_000_000 },
            members: [{
                profileId: 'work',
                priority: 10,
                enabled: false,
                state: {
                    exhaustedUntilMs: 1_800_000_010_000,
                    lastFailureKind: 'usage_limit',
                },
            }],
        }]);

        expect(group).toMatchObject({
            groupId: 'primary',
            label: 'Primary pool',
            activeProfileId: 'work',
            generation: 4,
            status: 'needs_members',
            cooldownUntilMs: 1_800_000_000_000,
            policy: {
                strategy: 'manual',
                autoSwitch: true,
            },
            members: [{
                profileId: 'work',
                enabled: false,
                priority: 10,
                exhaustedUntilMs: 1_800_000_010_000,
                lastFailureKind: 'usage_limit',
            }],
        });
    });

    it('formats member subtitle state from the normalized model', () => {
        const [group] = parseConnectedServiceGroupViewModels([{
            groupId: 'primary',
            activeProfileId: 'work',
            members: [{
                profileId: 'work',
                priority: 10,
                enabled: true,
                state: {
                    cooldownUntilMs: 1_800_000_000_000,
                    lastFailureKind: 'auth_expired',
                },
            }],
        }]);

        const subtitle = formatConnectedServiceGroupMemberSubtitle(group.members[0]!, group.activeProfileId);

        expect(subtitle).toContain(t('connectedServices.detail.groups.memberActive'));
        expect(subtitle).toContain(t('connectedServices.detail.groups.memberEnabled'));
        expect(subtitle).toContain(t('connectedServices.detail.groups.memberPriority', { priority: 10 }));
        expect(subtitle).toContain(t('connectedServices.detail.groups.memberLastFailure', { reason: 'auth_expired' }));
    });

    it('normalizes typed limiter fields and surfaces the concrete blocker in member subtitles', () => {
        const [group] = parseConnectedServiceGroupViewModels([{
            groupId: 'primary',
            activeProfileId: 'work',
            members: [
                {
                    profileId: 'work',
                    priority: 10,
                    enabled: true,
                    state: {
                        quotaExhaustedUntilMs: 1_800_000_010_000,
                        rateLimitedUntilMs: 1_800_000_020_000,
                        capacityLimitedUntilMs: 1_800_000_030_000,
                        authInvalidUntilMs: 1_800_000_040_000,
                        lastObservedAtMs: 1_800_000_000_000,
                        lastFailureKind: 'usage_limit',
                    },
                },
            ],
        }]);

        const member = group.members[0]!;
        const subtitle = formatConnectedServiceGroupMemberSubtitle(member, group.activeProfileId);

        expect(member).toMatchObject({
            quotaExhaustedUntilMs: 1_800_000_010_000,
            rateLimitedUntilMs: 1_800_000_020_000,
            capacityLimitedUntilMs: 1_800_000_030_000,
            authInvalidUntilMs: 1_800_000_040_000,
            lastObservedAtMs: 1_800_000_000_000,
            blocker: {
                kind: 'auth_invalid',
                untilMs: 1_800_000_040_000,
            },
            readiness: 'auth_invalid',
        });
        expect(subtitle).toContain(t('connectedServices.detail.groups.memberAuthInvalidUntil', {
            time: new Date(1_800_000_040_000).toLocaleString(),
        }));
        expect(subtitle).toContain(t('connectedServices.detail.groups.memberLastFailure', { reason: 'usage_limit' }));
    });

    it('does not surface expired limiter timestamps as active member blockers', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(1_800_000_100_000));
        try {
            const [group] = parseConnectedServiceGroupViewModels([{
                groupId: 'primary',
                activeProfileId: 'work',
                members: [
                    {
                        profileId: 'work',
                        priority: 10,
                        enabled: true,
                        state: {
                            quotaExhaustedUntilMs: 1_800_000_010_000,
                            lastObservedAtMs: 1_800_000_000_000,
                            lastFailureKind: 'usage_limit',
                        },
                    },
                ],
            }]);

            const member = group.members[0]!;
            const subtitle = formatConnectedServiceGroupMemberSubtitle(member, group.activeProfileId);

            expect(member.quotaExhaustedUntilMs).toBe(1_800_000_010_000);
            expect(member.blocker).toBeNull();
            expect(member.readiness).toBe('ready');
            expect(subtitle).not.toContain(t('connectedServices.detail.groups.memberQuotaExhaustedUntil', {
                time: new Date(1_800_000_010_000).toLocaleString(),
            }));
            expect(subtitle).toContain(t('connectedServices.detail.groups.memberLastFailure', { reason: 'usage_limit' }));
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not mark plan-unavailable or validation-blocked members as ready', () => {
        const [group] = parseConnectedServiceGroupViewModels([{
            groupId: 'primary',
            activeProfileId: 'work',
            members: [
                {
                    profileId: 'plan',
                    priority: 10,
                    enabled: true,
                    state: { planUnavailableUntilMs: 1_800_000_050_000 },
                },
                {
                    profileId: 'validation',
                    priority: 20,
                    enabled: true,
                    state: { validationBlockedUntilMs: 1_800_000_060_000 },
                },
            ],
        }]);

        expect(group.members[0]).toMatchObject({
            planUnavailableUntilMs: 1_800_000_050_000,
            blocker: { kind: 'plan_unavailable', untilMs: 1_800_000_050_000 },
            readiness: 'plan_unavailable',
        });
        expect(formatConnectedServiceGroupMemberSubtitle(group.members[0]!, group.activeProfileId)).toContain(
            t('connectedServices.detail.groups.memberPlanUnavailableUntil', {
                time: new Date(1_800_000_050_000).toLocaleString(),
            }),
        );

        expect(group.members[1]).toMatchObject({
            validationBlockedUntilMs: 1_800_000_060_000,
            blocker: { kind: 'validation_blocked', untilMs: 1_800_000_060_000 },
            readiness: 'validation_blocked',
        });
        expect(formatConnectedServiceGroupMemberSubtitle(group.members[1]!, group.activeProfileId)).toContain(
            t('connectedServices.detail.groups.memberValidationBlockedUntil', {
                time: new Date(1_800_000_060_000).toLocaleString(),
            }),
        );
    });

    it('resolves a unified member identity with the display label primary and raw id only when distinct', () => {
        const labelled = resolveConnectedServiceGroupMemberIdentity({
            serviceId: 'openai-codex',
            profileId: 'leeroy',
            labelsByKey: { 'openai-codex/leeroy': 'batiplus' },
            profiles: [{ profileId: 'leeroy', providerEmail: 'leeroy.brun@gmail.com' }],
        });
        expect(labelled).toMatchObject({ label: 'batiplus', id: 'leeroy', hasDistinctId: true });
        expect(labelled.secondaryLabel).toBe('leeroy.brun@gmail.com · leeroy');
        expect(labelled.visibleLabel).toContain('leeroy');

        const unlabelled = resolveConnectedServiceGroupMemberIdentity({
            serviceId: 'openai-codex',
            profileId: 'work',
            labelsByKey: {},
        });
        expect(unlabelled).toMatchObject({ label: 'work', id: 'work', hasDistinctId: false });
    });

    it('shows the active member by display label in the group subtitle, not the raw profile id', () => {
        const [group] = parseConnectedServiceGroupViewModels([{
            groupId: 'primary',
            activeProfileId: 'batiplus',
            members: [{ profileId: 'batiplus', priority: 10, enabled: true }],
        }]);

        const subtitle = formatConnectedServiceGroupSubtitle(group, {
            serviceId: 'claude-subscription',
            labelsByKey: { 'claude-subscription/batiplus': 'leeroy' },
        });

        expect(subtitle).toContain('leeroy');
        expect(subtitle).not.toContain(t('connectedServices.detail.groups.activeMember', {
            member: 'batiplus',
        }));
        expect(subtitle).toContain(t('connectedServices.detail.groups.activeMember', {
            member: 'leeroy · batiplus',
        }));
    });

    it('falls back to the raw profile id in the group subtitle when no label is configured', () => {
        const [group] = parseConnectedServiceGroupViewModels([{
            groupId: 'primary',
            activeProfileId: 'batiplus',
            members: [{ profileId: 'batiplus', priority: 10, enabled: true }],
        }]);

        const subtitle = formatConnectedServiceGroupSubtitle(group);

        expect(subtitle).toContain(t('connectedServices.detail.groups.activeMember', { member: 'batiplus' }));
    });

    it('keeps provider email visible when a custom member label masks the stable identity', () => {
        const [group] = parseConnectedServiceGroupViewModels([{
            groupId: 'primary',
            activeProfileId: 'leeroy',
            members: [{ profileId: 'leeroy', priority: 10, enabled: true }],
        }]);

        const identity = {
            serviceId: 'claude-subscription' as const,
            labelsByKey: { 'claude-subscription/leeroy': 'Personal' },
            profiles: [{ profileId: 'leeroy', providerEmail: 'leeroy.brun@gmail.com' }],
        };
        const summarySubtitle = formatConnectedServiceGroupSubtitle(group, identity);
        const memberSubtitle = formatConnectedServiceGroupMemberSubtitle(group.members[0]!, group.activeProfileId, identity);

        expect(summarySubtitle).toContain(t('connectedServices.detail.groups.activeMember', {
            member: 'Personal · leeroy.brun@gmail.com',
        }));
        expect(memberSubtitle).toContain('leeroy.brun@gmail.com');
    });

    it('uses profile labels when resolving group member titles', () => {
        expect(resolveConnectedServiceGroupProfileTitle({
            serviceId: 'openai-codex',
            profileId: 'work',
            labelsByKey: { 'openai-codex/work': 'Work account' },
        })).toBe('Work account');
    });

});
