/** Dependency-free Claude effort primitives, shared by the effort resolver and configuration parsing. */
export type ClaudeEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const CLAUDE_EFFORT_LEVEL_PRIORITY: readonly ClaudeEffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Normalize a Claude model id for the "is this a curated model?" check (strip `[1m]` + dated suffix). */
export function normalizeClaudeModelIdForKnownCheck(raw: unknown): string {
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    return value.replace(/\[[^\]]*\]$/u, '').replace(/-\d{8}$/u, '');
}

export function normalizeClaudeEffortLevel(raw: unknown): ClaudeEffortLevel | null {
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!value) return null;
    if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') return value;
    return null;
}
