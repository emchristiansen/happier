/**
 * The current newest / flagship Claude model id.
 *
 * Single source of truth for the few contexts that want "the best Claude model available
 * right now" rather than a pinned version: the Pi backend startup model, the OpenCode
 * retired-model replacement, and the bare `opus` alias. Bump this ONE constant when a new
 * flagship Opus ships — the selectable catalog in `../../models.ts` is maintained separately.
 *
 * Invariant: this must be an id present in `CLAUDE_STATIC_MODELS` (guarded by a catalog test),
 * so the constant can never drift to a model that is not actually selectable.
 */
export const CURRENT_FLAGSHIP_CLAUDE_MODEL_ID = 'claude-opus-5-5';
