import { parseClaudeSdkFlagOverridesFromArgs } from '../remote/sdkFlagOverrides';

/**
 * Seed the session's reasoning-effort state from a launch `--effort` flag.
 *
 * The flag is a session selection made at launch time, not a permanent override: a selection
 * persisted before this launch loses to it, while any later metadata or message selection
 * supersedes it through the same timestamped adoption as every other effort change. Launch
 * consumers read only the resulting session effort, never the raw flag.
 */
export function resolveLaunchReasoningEffortState(
  claudeArgs: readonly string[] | undefined,
  launchedAt: number,
): { value: string | undefined; updatedAt: number } {
  const value = parseClaudeSdkFlagOverridesFromArgs([...(claudeArgs ?? [])]).effort?.trim().toLowerCase();
  return value ? { value, updatedAt: launchedAt } : { value: undefined, updatedAt: 0 };
}
