import { describe, expect, it } from 'vitest';

import {
    SessionReminderPresetsV1Schema,
    formatSessionReminderPresetRuleLabel,
    inferSessionReminderPresetRule,
    resolveSessionReminderPresetRule,
    upsertSessionReminderPreset,
} from './sessionReminderPreset';

describe('sessionReminderPreset', () => {
    const now = new Date(2026, 8, 8, 14, 30, 0, 0); // Tuesday, local time.

    it('infers reusable local-calendar rules without persisting the selected timestamp', () => {
        expect(inferSessionReminderPresetRule(new Date(2026, 8, 9, 14, 0).getTime(), now.getTime())).toEqual({
            kind: 'relative_day',
            daysAhead: 1,
            minuteOfDay: 14 * 60,
        });
        expect(inferSessionReminderPresetRule(new Date(2026, 8, 11, 14, 0).getTime(), now.getTime())).toEqual({
            kind: 'next_weekday',
            weekday: 5,
            minuteOfDay: 14 * 60,
        });
        expect(inferSessionReminderPresetRule(new Date(2026, 8, 15, 16, 0).getTime(), now.getTime())).toEqual({
            kind: 'next_calendar_weekday',
            weekday: 2,
            minuteOfDay: 16 * 60,
        });
        expect(inferSessionReminderPresetRule(new Date(2026, 8, 27, 9, 15).getTime(), now.getTime())).toEqual({
            kind: 'next_calendar_weekday',
            weekday: 0,
            weeksAhead: 2,
            minuteOfDay: 9 * 60 + 15,
        });
    });

    it('resolves every rule to its next future local occurrence', () => {
        expect(resolveSessionReminderPresetRule({ kind: 'relative_day', daysAhead: 1, minuteOfDay: 14 * 60 }, now.getTime()))
            .toBe(new Date(2026, 8, 9, 14, 0).getTime());
        expect(resolveSessionReminderPresetRule({ kind: 'next_weekday', weekday: 2, minuteOfDay: 16 * 60 }, now.getTime()))
            .toBe(new Date(2026, 8, 8, 16, 0).getTime());
        expect(resolveSessionReminderPresetRule({ kind: 'next_weekday', weekday: 2, minuteOfDay: 9 * 60 }, now.getTime()))
            .toBe(new Date(2026, 8, 15, 9, 0).getTime());
        expect(resolveSessionReminderPresetRule({ kind: 'next_calendar_weekday', weekday: 2, minuteOfDay: 16 * 60 }, now.getTime()))
            .toBe(new Date(2026, 8, 15, 16, 0).getTime());
        expect(resolveSessionReminderPresetRule({ kind: 'next_calendar_weekday', weekday: 0, weeksAhead: 2, minuteOfDay: 9 * 60 }, now.getTime()))
            .toBe(new Date(2026, 8, 27, 9, 0).getTime());
    });

    it('describes reusable weekday rules instead of formatting their first absolute date', () => {
        expect(formatSessionReminderPresetRuleLabel(
            { kind: 'next_weekday', weekday: 5, minuteOfDay: 14 * 60 },
            now.getTime(),
            'en-US',
        )).toBe('Friday · 2:00 PM');
        expect(formatSessionReminderPresetRuleLabel(
            { kind: 'next_calendar_weekday', weekday: 2, minuteOfDay: 16 * 60 },
            now.getTime(),
            'en-US',
        )).toBe('Next Tuesday · 4:00 PM');
        expect(formatSessionReminderPresetRuleLabel(
            { kind: 'next_calendar_weekday', weekday: 0, weeksAhead: 2, minuteOfDay: 9 * 60 },
            now.getTime(),
            'en-US',
        )).toBe('Sunday in 2 weeks · 9:00 AM');
    });

    it('drops malformed synced entries and preserves valid ordered entries', () => {
        expect(SessionReminderPresetsV1Schema.parse([
            { rule: { kind: 'relative_day', daysAhead: 1, minuteOfDay: 840 } },
            { rule: { kind: 'next_weekday', weekday: 9, minuteOfDay: 840 } },
            { rule: { kind: 'next_calendar_weekday', weekday: 0, weeksAhead: 0, minuteOfDay: 540 } },
            { rule: { kind: 'next_calendar_weekday', weekday: 2, minuteOfDay: 960 }, label: 'Review day' },
        ])).toEqual([
            { rule: { kind: 'relative_day', daysAhead: 1, minuteOfDay: 840 } },
            { rule: { kind: 'next_calendar_weekday', weekday: 2, minuteOfDay: 960 }, label: 'Review day' },
        ]);
    });

    it('upserts the same semantic rule in place instead of creating duplicate choices', () => {
        const first = { rule: { kind: 'relative_day' as const, daysAhead: 1, minuteOfDay: 840 } };
        expect(upsertSessionReminderPreset([first], {
            rule: { kind: 'relative_day', daysAhead: 1, minuteOfDay: 840 },
            label: 'Tomorrow focus',
        })).toEqual([{
            rule: { kind: 'relative_day', daysAhead: 1, minuteOfDay: 840 },
            label: 'Tomorrow focus',
        }]);
    });
});
