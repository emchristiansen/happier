import {
  readSessionRunnerDebugLog,
  writeSessionRunnerDebugLog,
} from '@/daemon/spawn/sessionRunnerDebugLog';

const USAGE = 'Usage: happier daemon session-debug-log <on|off|status> <session-id>';

/**
 * `happier daemon session-debug-log <on|off|status> <session-id>`: set, clear or report the
 * per-session runner debug log switch. The switch applies at the session's next runner spawn.
 */
export async function runDaemonSessionDebugLogCommand(
  args: readonly string[],
  opts: Readonly<{ daemonStateDir: string }>,
): Promise<number> {
  const action = args[0];
  const sessionId = args[1]?.trim() ?? '';
  if ((action !== 'on' && action !== 'off' && action !== 'status') || !sessionId) {
    console.error(USAGE);
    return 1;
  }
  try {
    if (action !== 'status') {
      await writeSessionRunnerDebugLog({ daemonStateDir: opts.daemonStateDir, sessionId, enabled: action === 'on' });
    }
    const enabled = await readSessionRunnerDebugLog({ daemonStateDir: opts.daemonStateDir, sessionId });
    console.log(`Session runner debug log ${sessionId}: ${enabled ? 'on' : 'off'}`);
    if (action !== 'status') {
      console.log(
        'Applies at this session\'s next runner start; restart its runner with '
        + `\`happier daemon restart-session-runners --session-id ${sessionId} --force-current-cli\` to apply it now.`,
      );
    }
    return 0;
  } catch (error) {
    console.error(`Failed to ${action === 'status' ? 'read' : 'update'} the session runner debug log switch: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
