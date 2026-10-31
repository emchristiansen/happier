/** Claude SDK 0.3.243 / Claude Code 2.1.243 result contract, including error results. */
export function hasClaudeQueuedUserTurns(message: unknown): boolean {
    if (!message || typeof message !== 'object') return false;
    const result = message as Readonly<Record<string, unknown>>;
    return result.type === 'result'
        && typeof result.queued_turn_count === 'number'
        && Number.isSafeInteger(result.queued_turn_count)
        && result.queued_turn_count > 0;
}
