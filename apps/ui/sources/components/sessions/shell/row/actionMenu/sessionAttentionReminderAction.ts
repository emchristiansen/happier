import { resolveSessionReminderPresetRule } from '@/sync/domains/session/organization/sessionReminderPreset';

export const SESSION_ATTENTION_REMINDER_MENU_ID = 'attention-reminder';
export const SESSION_ATTENTION_REMINDER_ONE_HOUR_ID = 'attention-reminder:3600000';
export const SESSION_ATTENTION_REMINDER_THREE_HOURS_ID = 'attention-reminder:10800000';
export const SESSION_ATTENTION_REMINDER_TOMORROW_ID = 'attention-reminder:tomorrow';
export const SESSION_ATTENTION_REMINDER_NEXT_WEEK_ID = 'attention-reminder:next-week';
export const SESSION_ATTENTION_REMINDER_CUSTOM_ID = 'attention-reminder:custom';
export const SESSION_ATTENTION_REMINDER_PRESET_PREFIX = 'attention-reminder:preset:';
export const SESSION_ATTENTION_REMINDER_MANAGE_PRESETS_ID = 'attention-reminder:manage-presets';
export const SESSION_ATTENTION_REMINDER_CURRENT_ID = 'attention-reminder:current';
export const SESSION_ATTENTION_REMINDER_REMOVE_ID = 'attention-reminder:remove';

export type SessionAttentionReminderSelection =
    | Readonly<{ kind: 'timestamp'; remindAt: number }>
    | Readonly<{ kind: 'custom' }>
    | Readonly<{ kind: 'preset'; ruleKey: string }>
    | Readonly<{ kind: 'manage_presets' }>
    | Readonly<{ kind: 'current' }>
    | Readonly<{ kind: 'remove' }>;

export function resolveSessionAttentionReminderSelection(
    itemId: string,
    nowMs: number,
): SessionAttentionReminderSelection | null {
    if (itemId === SESSION_ATTENTION_REMINDER_CUSTOM_ID) {
        return { kind: 'custom' };
    }
    if (itemId === SESSION_ATTENTION_REMINDER_MANAGE_PRESETS_ID) {
        return { kind: 'manage_presets' };
    }
    if (itemId === SESSION_ATTENTION_REMINDER_CURRENT_ID) return { kind: 'current' };
    if (itemId === SESSION_ATTENTION_REMINDER_REMOVE_ID) return { kind: 'remove' };
    if (itemId.startsWith(SESSION_ATTENTION_REMINDER_PRESET_PREFIX)) {
        return { kind: 'preset', ruleKey: itemId.slice(SESSION_ATTENTION_REMINDER_PRESET_PREFIX.length) };
    }
    if (itemId === SESSION_ATTENTION_REMINDER_ONE_HOUR_ID) {
        return { kind: 'timestamp', remindAt: nowMs + 60 * 60 * 1_000 };
    }
    if (itemId === SESSION_ATTENTION_REMINDER_THREE_HOURS_ID) {
        return { kind: 'timestamp', remindAt: nowMs + 3 * 60 * 60 * 1_000 };
    }

    if (itemId === SESSION_ATTENTION_REMINDER_TOMORROW_ID) {
        return {
            kind: 'timestamp',
            remindAt: resolveSessionReminderPresetRule({ kind: 'relative_day', daysAhead: 1, minuteOfDay: 9 * 60 }, nowMs),
        };
    }
    if (itemId === SESSION_ATTENTION_REMINDER_NEXT_WEEK_ID) {
        return {
            kind: 'timestamp',
            remindAt: resolveSessionReminderPresetRule({ kind: 'next_calendar_weekday', weekday: 1, minuteOfDay: 9 * 60 }, nowMs),
        };
    }
    return null;
}

export function formatSessionAttentionReminderDateTime(remindAt: number, nowMs: number): string {
    const reminderDate = new Date(remindAt);
    const nowDate = new Date(nowMs);
    return new Intl.DateTimeFormat(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        ...(reminderDate.getFullYear() === nowDate.getFullYear() ? {} : { year: 'numeric' as const }),
        hour: 'numeric',
        minute: '2-digit',
    }).format(reminderDate);
}
