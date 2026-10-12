import { describe, expect, it } from 'vitest';

import {
    resolveSessionAttentionReminderSelection,
    SESSION_ATTENTION_REMINDER_CUSTOM_ID,
    SESSION_ATTENTION_REMINDER_NEXT_WEEK_ID,
    SESSION_ATTENTION_REMINDER_ONE_HOUR_ID,
    SESSION_ATTENTION_REMINDER_TOMORROW_ID,
    SESSION_ATTENTION_REMINDER_MANAGE_PRESETS_ID,
    SESSION_ATTENTION_REMINDER_PRESET_PREFIX,
    SESSION_ATTENTION_REMINDER_CURRENT_ID,
    SESSION_ATTENTION_REMINDER_REMOVE_ID,
} from './sessionAttentionReminderAction';

describe('resolveSessionAttentionReminderSelection', () => {
    it('resolves relative, calendar, and custom reminder choices', () => {
        const now = new Date(2026, 8, 8, 14, 30, 0, 0); // Tuesday, local time.

        expect(resolveSessionAttentionReminderSelection(
            SESSION_ATTENTION_REMINDER_ONE_HOUR_ID,
            now.getTime(),
        )).toEqual({ kind: 'timestamp', remindAt: now.getTime() + 60 * 60 * 1_000 });

        const tomorrow = new Date(2026, 8, 9, 9, 0, 0, 0);
        expect(resolveSessionAttentionReminderSelection(
            SESSION_ATTENTION_REMINDER_TOMORROW_ID,
            now.getTime(),
        )).toEqual({ kind: 'timestamp', remindAt: tomorrow.getTime() });

        const nextWeek = new Date(2026, 8, 14, 9, 0, 0, 0);
        expect(resolveSessionAttentionReminderSelection(
            SESSION_ATTENTION_REMINDER_NEXT_WEEK_ID,
            now.getTime(),
        )).toEqual({ kind: 'timestamp', remindAt: nextWeek.getTime() });

        expect(resolveSessionAttentionReminderSelection(
            SESSION_ATTENTION_REMINDER_CUSTOM_ID,
            now.getTime(),
        )).toEqual({ kind: 'custom' });
        expect(resolveSessionAttentionReminderSelection(
            `${SESSION_ATTENTION_REMINDER_PRESET_PREFIX}relative_day:1:840`,
            now.getTime(),
        )).toEqual({ kind: 'preset', ruleKey: 'relative_day:1:840' });
        expect(resolveSessionAttentionReminderSelection(
            SESSION_ATTENTION_REMINDER_MANAGE_PRESETS_ID,
            now.getTime(),
        )).toEqual({ kind: 'manage_presets' });
        expect(resolveSessionAttentionReminderSelection(
            SESSION_ATTENTION_REMINDER_CURRENT_ID,
            now.getTime(),
        )).toEqual({ kind: 'current' });
        expect(resolveSessionAttentionReminderSelection(
            SESSION_ATTENTION_REMINDER_REMOVE_ID,
            now.getTime(),
        )).toEqual({ kind: 'remove' });
        expect(resolveSessionAttentionReminderSelection('attention-reminder:unknown', now.getTime())).toBeNull();
    });
});
