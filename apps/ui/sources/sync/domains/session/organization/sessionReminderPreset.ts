import { z } from 'zod';

const MINUTES_PER_DAY = 24 * 60;
const MILLIS_PER_DAY = 24 * 60 * 60 * 1_000;
export const SESSION_REMINDER_PRESET_LABEL_MAX_LENGTH = 80;

const MinuteOfDaySchema = z.number().int().min(0).max(MINUTES_PER_DAY - 1);
const WeekdaySchema = z.number().int().min(0).max(6);

export const SessionReminderPresetRuleSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('relative_day'),
        daysAhead: z.number().int().min(1),
        minuteOfDay: MinuteOfDaySchema,
    }),
    z.object({
        kind: z.literal('next_weekday'),
        weekday: WeekdaySchema,
        minuteOfDay: MinuteOfDaySchema,
    }),
    z.object({
        kind: z.literal('next_calendar_weekday'),
        weekday: WeekdaySchema,
        weeksAhead: z.number().int().min(1).optional(),
        minuteOfDay: MinuteOfDaySchema,
    }),
]);

export const SessionReminderPresetV1Schema = z.object({
    rule: SessionReminderPresetRuleSchema,
    label: z.string().trim().min(1).max(SESSION_REMINDER_PRESET_LABEL_MAX_LENGTH).optional(),
});

export const SessionReminderPresetsV1Schema = z.preprocess((value) => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
        const parsed = SessionReminderPresetV1Schema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
    });
}, z.array(SessionReminderPresetV1Schema));

export type SessionReminderPresetRule = z.infer<typeof SessionReminderPresetRuleSchema>;
export type SessionReminderPresetV1 = z.infer<typeof SessionReminderPresetV1Schema>;

function localDayOrdinal(date: Date): number {
    return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MILLIS_PER_DAY);
}

function localWeekStartOrdinal(date: Date): number {
    const mondayBasedDay = (date.getDay() + 6) % 7;
    return localDayOrdinal(date) - mondayBasedDay;
}

function setLocalMinuteOfDay(date: Date, minuteOfDay: number): void {
    date.setHours(Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, 0);
}

export function sessionReminderPresetRuleKey(rule: SessionReminderPresetRule): string {
    if (rule.kind === 'relative_day') {
        return `${rule.kind}:${rule.daysAhead}:${rule.minuteOfDay}`;
    }
    if (rule.kind === 'next_calendar_weekday') {
        return `${rule.kind}:${rule.weekday}:${rule.weeksAhead ?? 1}:${rule.minuteOfDay}`;
    }
    return `${rule.kind}:${rule.weekday}:${rule.minuteOfDay}`;
}

export function inferSessionReminderPresetRule(
    selectedMs: number,
    nowMs = Date.now(),
): SessionReminderPresetRule | null {
    if (!Number.isFinite(selectedMs) || !Number.isFinite(nowMs) || selectedMs <= nowMs) return null;

    const selected = new Date(selectedMs);
    const now = new Date(nowMs);
    const daysAhead = localDayOrdinal(selected) - localDayOrdinal(now);
    if (daysAhead < 0) return null;

    const minuteOfDay = selected.getHours() * 60 + selected.getMinutes();
    const weeksAhead = (localWeekStartOrdinal(selected) - localWeekStartOrdinal(now)) / 7;

    if (daysAhead === 1) {
        return { kind: 'relative_day', daysAhead, minuteOfDay };
    }
    if (weeksAhead === 0) {
        return { kind: 'next_weekday', weekday: selected.getDay(), minuteOfDay };
    }
    if (weeksAhead >= 1) {
        return {
            kind: 'next_calendar_weekday',
            weekday: selected.getDay(),
            ...(weeksAhead > 1 ? { weeksAhead } : {}),
            minuteOfDay,
        };
    }
    return { kind: 'relative_day', daysAhead, minuteOfDay };
}

export function resolveSessionReminderPresetRule(
    rule: SessionReminderPresetRule,
    nowMs = Date.now(),
): number {
    const now = new Date(nowMs);
    const resolved = new Date(nowMs);

    if (rule.kind === 'relative_day') {
        resolved.setDate(resolved.getDate() + rule.daysAhead);
        setLocalMinuteOfDay(resolved, rule.minuteOfDay);
        return resolved.getTime();
    }

    if (rule.kind === 'next_calendar_weekday') {
        const mondayBasedToday = (now.getDay() + 6) % 7;
        const mondayBasedTarget = (rule.weekday + 6) % 7;
        resolved.setDate(resolved.getDate() - mondayBasedToday + (rule.weeksAhead ?? 1) * 7 + mondayBasedTarget);
        setLocalMinuteOfDay(resolved, rule.minuteOfDay);
        return resolved.getTime();
    }

    const daysUntilWeekday = (rule.weekday - now.getDay() + 7) % 7;
    resolved.setDate(resolved.getDate() + daysUntilWeekday);
    setLocalMinuteOfDay(resolved, rule.minuteOfDay);
    if (resolved.getTime() <= nowMs) {
        resolved.setDate(resolved.getDate() + 7);
        setLocalMinuteOfDay(resolved, rule.minuteOfDay);
    }
    return resolved.getTime();
}

export function upsertSessionReminderPreset(
    presets: readonly SessionReminderPresetV1[],
    nextPreset: SessionReminderPresetV1,
): SessionReminderPresetV1[] {
    const nextKey = sessionReminderPresetRuleKey(nextPreset.rule);
    const existingIndex = presets.findIndex((preset) => sessionReminderPresetRuleKey(preset.rule) === nextKey);
    if (existingIndex < 0) return [...presets, nextPreset];

    return presets.map((preset, index) => index === existingIndex ? nextPreset : preset);
}

export function formatSessionReminderPresetRuleLabel(
    rule: SessionReminderPresetRule,
    nowMs = Date.now(),
    locales?: Intl.LocalesArgument,
): string {
    const resolved = new Date(resolveSessionReminderPresetRule(rule, nowMs));
    const time = new Intl.DateTimeFormat(locales, { hour: 'numeric', minute: '2-digit' }).format(resolved);
    if (rule.kind === 'relative_day' && rule.daysAhead === 1) {
        const relative = new Intl.RelativeTimeFormat(locales, { numeric: 'auto' }).format(1, 'day');
        return `${relative.charAt(0).toLocaleUpperCase() + relative.slice(1)} · ${time}`;
    }
    if (rule.kind === 'relative_day') {
        const relative = new Intl.RelativeTimeFormat(locales, { numeric: 'always' }).format(rule.daysAhead, 'day');
        return `${relative.charAt(0).toLocaleUpperCase() + relative.slice(1)} · ${time}`;
    }
    const weekday = new Intl.DateTimeFormat(locales, { weekday: 'long' }).format(resolved);
    if (rule.kind === 'next_weekday') return `${weekday} · ${time}`;
    const weeksAhead = rule.weeksAhead ?? 1;
    const locale = new Intl.DateTimeFormat(locales).resolvedOptions().locale;
    if (locale.toLowerCase().startsWith('en')) {
        return weeksAhead === 1
            ? `Next ${weekday} · ${time}`
            : `${weekday} ${new Intl.RelativeTimeFormat(locales, { numeric: 'always' }).format(weeksAhead, 'week')} · ${time}`;
    }
    const nextWeek = new Intl.RelativeTimeFormat(locales, { numeric: weeksAhead === 1 ? 'auto' : 'always' }).format(weeksAhead, 'week');
    return `${nextWeek.charAt(0).toLocaleUpperCase() + nextWeek.slice(1)} · ${weekday} · ${time}`;
}
