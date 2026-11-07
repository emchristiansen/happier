import { describe, expect, it } from 'vitest';

import { classifyClaudeStartupRefusal } from './claudeStartupRefusal';

/**
 * Observed refusal (Claude Code 2.1.278, reproduced 2026-09-19): the provider prints one line and
 * exits 1 before any session starts, so an interactive launch leaves only this text behind.
 */
const HELD_SESSION_TEXT = 'Error: Session 726be323-041a-4f51-aa76-0c5a6fe4bb22 is running as a '
  + 'background session (726be323). Run `claude attach 726be323` to open it, or `claude stop '
  + '726be323` first to resume it here. Add --fork-session to branch off a copy instead.';

describe('classifyClaudeStartupRefusal', () => {
  it('classifies a held session from the provider text an interactive launch leaves behind', () => {
    const refusal = classifyClaudeStartupRefusal({ text: HELD_SESSION_TEXT });

    expect(refusal?.code).toBe('session_held_by_background');
    expect(refusal?.retryable).toBe(false);
    expect(refusal?.guidance).toContain('claude stop');
  });

  it('prefers the structured reason over the text', () => {
    const refusal = classifyClaudeStartupRefusal({
      structuredReason: 'cli_version_too_old',
      text: HELD_SESSION_TEXT,
    });

    expect(refusal?.code).toBe('cli_version_too_old');
  });

  it('keeps the one refusal Claude documents as transient retryable', () => {
    expect(classifyClaudeStartupRefusal({ structuredReason: 'worktree_unverified' })?.retryable).toBe(true);
    expect(classifyClaudeStartupRefusal({ structuredReason: 'worktree_resume_refused' })?.retryable).toBe(false);
  });

  it('does not invent a refusal from an unrelated failure', () => {
    expect(classifyClaudeStartupRefusal({ text: 'No conversation found with session ID: abc' })).toBeNull();
    expect(classifyClaudeStartupRefusal({ text: 'connection reset by peer' })).toBeNull();
    expect(classifyClaudeStartupRefusal({ structuredReason: 'something_else' })).toBeNull();
    expect(classifyClaudeStartupRefusal({})).toBeNull();
    expect(classifyClaudeStartupRefusal({ text: '   ' })).toBeNull();
  });
});
