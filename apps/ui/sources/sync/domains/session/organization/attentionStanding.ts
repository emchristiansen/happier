/**
 * Attention standing is the user's explicit instruction to keep a session in
 * the Needs attention band after it has been read. Standing is resolved from
 * an account default plus per-session overrides, and this module is the single
 * owner of that rule: an explicit override always wins, so a session the user
 * removed from Needs attention stays out even while the default keeps every
 * other session standing (and vice versa). Overrides are stored as a real
 * boolean because "explicitly not standing" is not expressible by row absence
 * once the default is true.
 */
export type SessionAttentionStandingPolicy = Readonly<{
    defaultStanding: boolean;
    overridesBySessionKey: Readonly<Record<string, boolean | SessionAttentionIntentRecord>>;
}>;

export type SessionAttentionIntentRecord = Readonly<{ standing: boolean; remindAt?: number; updatedAt: number }>;
export type SessionAttentionIntent = 'suppress' | 'keep' | 'scheduled' | 'due';
export type SessionReminderPresentation = Readonly<{
    state: 'scheduled' | 'due';
    remindAt: number;
}>;

export function resolveSessionAttentionIntent(record: SessionAttentionIntentRecord, nowMs: number): SessionAttentionIntent {
    if (record.remindAt !== undefined) return record.remindAt > nowMs ? 'scheduled' : 'due';
    return record.standing ? 'keep' : 'suppress';
}

export function resolveSessionReminderPresentation(
    record: boolean | SessionAttentionIntentRecord | undefined,
    nowMs: number,
): SessionReminderPresentation | null {
    if (typeof record !== 'object' || typeof record.remindAt !== 'number') return null;
    return {
        state: record.remindAt > nowMs ? 'scheduled' : 'due',
        remindAt: record.remindAt,
    };
}

export function resolveNextSessionAttentionReminderWakeAtMs(
    policy: SessionAttentionStandingPolicy,
    nowMs: number,
): number | null {
    let nextAt: number | null = null;
    for (const record of Object.values(policy.overridesBySessionKey)) {
        if (typeof record !== 'object' || typeof record.remindAt !== 'number' || record.remindAt <= nowMs) continue;
        nextAt = nextAt === null ? record.remindAt : Math.min(nextAt, record.remindAt);
    }
    return nextAt;
}

/**
 * Where a session's standing comes from. Consumers that must treat the user's
 * explicit per-session instruction differently from a blanket account default
 * — hiding inactive sessions, for instance — read the source instead of
 * re-deriving the precedence rule.
 */
export type SessionAttentionStandingSource = 'override' | 'default' | 'none';

export function resolveSessionAttentionStandingSource(
    policy: SessionAttentionStandingPolicy,
    sessionKey: string,
    nowMs: number = Date.now(),
): SessionAttentionStandingSource {
    const override = policy.overridesBySessionKey[sessionKey];
    if (override !== undefined) {
        if (typeof override === 'boolean') return override ? 'override' : 'none';
        const intent = resolveSessionAttentionIntent(override, nowMs);
        return intent === 'keep' || intent === 'due' ? 'override' : 'none';
    }
    return policy.defaultStanding ? 'default' : 'none';
}

export function resolveSessionAttentionStanding(
    policy: SessionAttentionStandingPolicy,
    sessionKey: string,
    nowMs: number = Date.now(),
): boolean {
    return resolveSessionAttentionStandingSource(policy, sessionKey, nowMs) !== 'none';
}
