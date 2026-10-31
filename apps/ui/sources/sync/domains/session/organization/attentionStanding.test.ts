import { describe, expect, it } from 'vitest';

import {
    resolveSessionAttentionIntent,
    resolveSessionReminderPresentation,
    resolveNextSessionAttentionReminderWakeAtMs,
    resolveSessionAttentionStanding,
    resolveSessionAttentionStandingSource,
    type SessionAttentionStandingPolicy,
} from './attentionStanding';

describe('resolveSessionAttentionIntent', () => {
    it('keeps future reminders quiet and makes them due exactly at their deadline', () => {
        expect(resolveSessionAttentionIntent({ standing: true, remindAt: 2_000, updatedAt: 1 }, 1_999)).toBe('scheduled');
        expect(resolveSessionAttentionIntent({ standing: false, remindAt: 2_000, updatedAt: 1 }, 1_999)).toBe('scheduled');
        expect(resolveSessionAttentionIntent({ standing: true, remindAt: 2_000, updatedAt: 1 }, 2_000)).toBe('due');
        expect(resolveSessionAttentionIntent({ standing: false, remindAt: 2_000, updatedAt: 1 }, 2_000)).toBe('due');
        expect(resolveSessionAttentionIntent({ standing: true, updatedAt: 1 }, 1_999)).toBe('keep');
        expect(resolveSessionAttentionIntent({ standing: false, updatedAt: 1 }, 1_999)).toBe('suppress');
    });
});

describe('resolveSessionReminderPresentation', () => {
    it('projects the stored reminder once for rows and action menus', () => {
        expect(resolveSessionReminderPresentation(undefined, 1_000)).toBeNull();
        expect(resolveSessionReminderPresentation(true, 1_000)).toBeNull();
        expect(resolveSessionReminderPresentation({ standing: false, remindAt: 2_000, updatedAt: 1 }, 1_000))
            .toEqual({ state: 'scheduled', remindAt: 2_000 });
        expect(resolveSessionReminderPresentation({ standing: true, remindAt: 2_000, updatedAt: 1 }, 1_000))
            .toEqual({ state: 'scheduled', remindAt: 2_000 });
        expect(resolveSessionReminderPresentation({ standing: true, remindAt: 2_000, updatedAt: 1 }, 2_000))
            .toEqual({ state: 'due', remindAt: 2_000 });
    });
});

describe('resolveNextSessionAttentionReminderWakeAtMs', () => {
    it('returns the earliest future reminder across the full policy', () => {
        expect(resolveNextSessionAttentionReminderWakeAtMs(policy({
            overridesBySessionKey: {
                a: { standing: true, remindAt: 4_000, updatedAt: 1 },
                b: { standing: true, remindAt: 2_000, updatedAt: 1 },
                c: { standing: true, remindAt: 900, updatedAt: 1 },
                d: false,
            },
        }), 1_000)).toBe(2_000);
    });
});

function policy(overrides?: Partial<SessionAttentionStandingPolicy>): SessionAttentionStandingPolicy {
    return {
        defaultStanding: false,
        overridesBySessionKey: {},
        ...overrides,
    };
}

describe('resolveSessionAttentionStanding', () => {
    it('lets an explicit override win over the account default in both directions', () => {
        expect(resolveSessionAttentionStanding(
            policy({ defaultStanding: false, overridesBySessionKey: { 'server-a:s1': true } }),
            'server-a:s1',
        )).toBe(true);
        expect(resolveSessionAttentionStanding(
            policy({ defaultStanding: true, overridesBySessionKey: { 'server-a:s1': false } }),
            'server-a:s1',
        )).toBe(false);
    });

    it('inherits the account default for a session with no override of its own', () => {
        const overridesBySessionKey = { 'server-a:other': true };

        expect(resolveSessionAttentionStanding(
            policy({ defaultStanding: false, overridesBySessionKey }),
            'server-a:s1',
        )).toBe(false);
        expect(resolveSessionAttentionStanding(
            policy({ defaultStanding: true, overridesBySessionKey }),
            'server-a:s1',
        )).toBe(true);
    });

    it('reports whether standing came from the session override or the account default', () => {
        expect(resolveSessionAttentionStandingSource(
            policy({ defaultStanding: false, overridesBySessionKey: { 'server-a:s1': true } }),
            'server-a:s1',
        )).toBe('override');
        expect(resolveSessionAttentionStandingSource(
            policy({ defaultStanding: true, overridesBySessionKey: {} }),
            'server-a:s1',
        )).toBe('default');
        expect(resolveSessionAttentionStandingSource(
            policy({ defaultStanding: true, overridesBySessionKey: { 'server-a:s1': false } }),
            'server-a:s1',
        )).toBe('none');
        expect(resolveSessionAttentionStandingSource(
            policy({ defaultStanding: false, overridesBySessionKey: {} }),
            'server-a:s1',
        )).toBe('none');
    });
});
