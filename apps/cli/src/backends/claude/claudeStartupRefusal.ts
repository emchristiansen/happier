/**
 * Claude refuses some launches before its session ever starts. The refusal is deterministic for a
 * given set of launch arguments: relaunching with the same arguments reproduces it exactly, so a
 * retry budget spent on one is guaranteed to burn (live reports 2026-09-19: four identical
 * relaunches, then the queued message was paused).
 *
 * Claude names these refusals itself. Its startup error enum is described as
 * "Why Claude Code refused to start, so a host can offer the fix instead of a retry" — Happier is
 * that host, so this module turns a refusal into the fix to offer instead of a retry.
 *
 * Two evidence grades feed the classifier, and they are deliberately not treated alike:
 *
 * - `structuredReason` is the `startupFailureReason` Claude reports on its machine-readable
 *   surfaces. It is authoritative and matched exactly.
 * - `text` is whatever the provider printed before exiting, which is all an interactive terminal
 *   launch leaves behind. Only refusals whose exact wording has been observed are matched here;
 *   the rest stay structured-only rather than guessing at prose that may never have existed.
 */

/** Startup refusal codes Claude reports, as named by its own startup error enum. */
export type ClaudeStartupRefusalCode =
  | 'org_pin_api_key_conflict'
  | 'org_verify_failed'
  | 'org_pin_mismatch'
  | 'managed_settings_invalid'
  | 'remote_settings_required_unavailable'
  | 'gateway_signin_required'
  | 'gateway_access_denied'
  | 'proxy_invalid'
  | 'temp_dir_unusable'
  | 'cwd_unavailable'
  | 'shell_tool_missing'
  | 'session_held_by_background'
  | 'worktree_resume_refused'
  | 'worktree_unverified'
  | 'cli_version_too_old'
  | 'bypass_root';

export type ClaudeStartupRefusal = Readonly<{
  code: ClaudeStartupRefusalCode;
  /**
   * Whether relaunching with the same arguments can plausibly succeed. Only refusals Claude
   * documents as transient are retryable; everything else needs the launch or the environment to
   * change first, so retrying only delays the report.
   */
  retryable: boolean;
  /** What the person should do, phrased for a Happier session event rather than a terminal. */
  guidance: string;
}>;

const REFUSAL_CODES = new Set<string>([
  'org_pin_api_key_conflict',
  'org_verify_failed',
  'org_pin_mismatch',
  'managed_settings_invalid',
  'remote_settings_required_unavailable',
  'gateway_signin_required',
  'gateway_access_denied',
  'proxy_invalid',
  'temp_dir_unusable',
  'cwd_unavailable',
  'shell_tool_missing',
  'session_held_by_background',
  'worktree_resume_refused',
  'worktree_unverified',
  'cli_version_too_old',
  'bypass_root',
] satisfies readonly ClaudeStartupRefusalCode[]);

/**
 * Claude documents `worktree_unverified` as "retrying may succeed"; every other refusal needs the
 * launch or the environment to change first.
 */
const RETRYABLE_REFUSAL_CODES = new Set<ClaudeStartupRefusalCode>(['worktree_unverified']);

const REFUSAL_GUIDANCE: Readonly<Record<ClaudeStartupRefusalCode, string>> = {
  org_pin_api_key_conflict: 'Claude refused to start because an organization pin conflicts with the configured API key.',
  org_verify_failed: 'Claude refused to start because it could not verify the organization.',
  org_pin_mismatch: 'Claude refused to start because the organization pin does not match this account.',
  managed_settings_invalid: 'Claude refused to start because managed settings are invalid.',
  remote_settings_required_unavailable: 'Claude refused to start because required managed settings could not be loaded.',
  gateway_signin_required: 'Claude refused to start because the Cloud gateway needs a new sign-in.',
  gateway_access_denied: 'Claude refused to start because the Cloud gateway denied this account.',
  proxy_invalid: 'Claude refused to start because a proxy setting is not a complete URL.',
  temp_dir_unusable: 'Claude refused to start because its per-user temp directory is unsafe or could not be created.',
  cwd_unavailable: 'Claude refused to start because this session\'s working directory was deleted, moved, or cannot be read.',
  shell_tool_missing: 'Claude refused to start because no usable shell tool is available.',
  session_held_by_background: 'Claude refused to resume this conversation because another Claude process is still running it. '
    + 'Stop that session (`claude stop <id>`) or open it with `claude attach <id>`, then send the message again.',
  worktree_resume_refused: 'Claude refused to resume because this session\'s worktree failed its safety checks.',
  worktree_unverified: 'Claude could not verify this session\'s worktree right now.',
  cli_version_too_old: 'Claude refused to start because this Claude Code version is below the minimum Anthropic requires. Update the Claude CLI.',
  bypass_root: 'Claude refused to start because permission bypass is not allowed while running as root.',
};

/**
 * Observed refusal wording, for launches that leave nothing but the provider's own output.
 *
 * Only exact phrases seen in a real refusal belong here. `session_held_by_background` is present
 * because its wording was observed both in Claude 2.1.278 and in a user report; the remaining
 * codes stay structured-only until their prose is actually observed, so a guessed pattern can
 * never misclassify an unrelated failure as a deterministic refusal.
 */
const OBSERVED_REFUSAL_TEXT: ReadonlyArray<Readonly<{
  code: ClaudeStartupRefusalCode;
  pattern: RegExp;
}>> = [
  { code: 'session_held_by_background', pattern: /is running as a background session/i },
];

function classifyStructuredReason(value: string): ClaudeStartupRefusalCode | null {
  const reason = value.trim();
  return REFUSAL_CODES.has(reason) ? reason as ClaudeStartupRefusalCode : null;
}

function classifyRefusalText(value: string): ClaudeStartupRefusalCode | null {
  for (const candidate of OBSERVED_REFUSAL_TEXT) {
    if (candidate.pattern.test(value)) return candidate.code;
  }
  return null;
}

function buildRefusal(code: ClaudeStartupRefusalCode): ClaudeStartupRefusal {
  return {
    code,
    retryable: RETRYABLE_REFUSAL_CODES.has(code),
    guidance: REFUSAL_GUIDANCE[code],
  };
}

/**
 * Resolve a provider startup refusal from whatever the launch surface produced. Structured
 * evidence wins over text so a machine-readable surface never depends on prose matching.
 * Returns null when nothing proves a refusal — an unrecognized failure keeps its existing
 * handling rather than being force-fit into this path.
 */
export function classifyClaudeStartupRefusal(input: Readonly<{
  structuredReason?: string | null | undefined;
  text?: string | null | undefined;
}>): ClaudeStartupRefusal | null {
  const structuredReason = typeof input.structuredReason === 'string'
    ? classifyStructuredReason(input.structuredReason)
    : null;
  if (structuredReason) return buildRefusal(structuredReason);

  const text = typeof input.text === 'string' && input.text.trim().length > 0 ? input.text : null;
  const textReason = text ? classifyRefusalText(text) : null;
  return textReason ? buildRefusal(textReason) : null;
}
