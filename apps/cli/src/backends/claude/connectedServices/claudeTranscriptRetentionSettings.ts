import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

/**
 * Claude Code deletes transcripts older than `cleanupPeriodDays` (default 30) at startup, from the
 * `projects` store its config dir reaches, including a shared native store. It accepts any positive
 * integer and computes its cutoff as now minus that many days; this value places the cutoff before
 * every representable file time without producing an invalid date.
 */
export const CLAUDE_HOME_TRANSCRIPT_RETENTION_CLEANUP_PERIOD_DAYS = 100_000_000;

/**
 * Adds the retention default to Claude settings content that lacks `cleanupPeriodDays`. A present
 * value is user-provided and kept; content that is not a JSON object is returned unchanged.
 */
export function withClaudeTranscriptRetentionDefault(content: string): string {
  let settings: unknown = {};
  if (content.trim()) {
    try { settings = JSON.parse(content); } catch { return content; }
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return content;
  if (Object.prototype.hasOwnProperty.call(settings, 'cleanupPeriodDays')) return content;
  return `${JSON.stringify({ ...settings, cleanupPeriodDays: CLAUDE_HOME_TRANSCRIPT_RETENTION_CLEANUP_PERIOD_DAYS }, null, 2)}\n`;
}

/**
 * Reads (following links, never writing) whether a settings file is absent, lacks the retention
 * setting, or already decides it. Unreadable or non-object content is left to its owner.
 */
export async function readClaudeSettingsTranscriptRetention(path: string): Promise<'missing' | 'lacking' | 'decided'> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'decided';
  }
  return withClaudeTranscriptRetentionDefault(content) === content ? 'decided' : 'lacking';
}

/**
 * Ensures a materialized home's own (non-linked) settings file carries the retention default.
 * A symbolic link is never written through: its target belongs to another home.
 */
export async function ensureClaudeHomeTranscriptRetention(settingsPath: string): Promise<void> {
  let content = '';
  try {
    const info = await lstat(settingsPath);
    if (!info.isFile()) return;
    content = await readFile(settingsPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const next = withClaudeTranscriptRetentionDefault(content);
  if (next === content) return;
  const temporary = `${settingsPath}.happier-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, next, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, settingsPath);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
