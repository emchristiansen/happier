import {
    CLAUDE_EFFORT_LEVEL_PRIORITY,
    normalizeClaudeEffortLevel,
    normalizeClaudeModelIdForKnownCheck,
    type ClaudeEffortLevel,
} from './claudeEffortLevel';

export const CLAUDE_MODEL_EFFORT_OVERRIDES_ENV = 'HAPPIER_CLAUDE_MODEL_EFFORT_OVERRIDES';

/**
 * Operator-configured per-model effort, e.g. `{"claude-opus-5-5":"medium"}`. Unset by default.
 *
 * A pinned model always runs at its configured effort, whatever a launch flag, spawn option,
 * message, metadata or runtime-control selection asks for; other models are untouched. Keys are
 * model ids exactly as Happier launches them (`[1m]` and dated suffixes tolerated); an alias or a
 * launch without an explicit model is matched only by its own literal key. Changing or removing
 * the variable reverses it. A malformed value is an error, never a silently ignored policy.
 */
export type ClaudeModelEffortOverridesConfig =
    | Readonly<{ ok: true; overrides: ReadonlyMap<string, ClaudeEffortLevel> }>
    | Readonly<{ ok: false; error: string }>;

export function parseClaudeModelEffortOverrides(rawValue: string | undefined): ClaudeModelEffortOverridesConfig {
    const raw = rawValue?.trim();
    if (!raw) return { ok: true, overrides: new Map() };
    const shapeError = `${CLAUDE_MODEL_EFFORT_OVERRIDES_ENV} must be a JSON object of model id to effort level`;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { ok: false, error: shapeError };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false, error: shapeError };
    }
    const overrides = new Map<string, ClaudeEffortLevel>();
    for (const [modelId, effortRaw] of Object.entries(parsed)) {
        const normalizedModelId = normalizeClaudeModelIdForKnownCheck(modelId);
        const effort = normalizeClaudeEffortLevel(effortRaw);
        if (!normalizedModelId || !effort) {
            return {
                ok: false,
                error: `${CLAUDE_MODEL_EFFORT_OVERRIDES_ENV} entry ${JSON.stringify(modelId)} needs a model id and one of ${CLAUDE_EFFORT_LEVEL_PRIORITY.join(', ')}`,
            };
        }
        overrides.set(normalizedModelId, effort);
    }
    return { ok: true, overrides };
}
