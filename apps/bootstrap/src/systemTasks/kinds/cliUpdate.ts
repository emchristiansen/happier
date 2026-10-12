import { systemTasks } from '@happier-dev/cli-common';

import { reportCliAcquisitionProgress } from '../cliAcquisitionProgress.js';
import { updateManagedLocalHappierCli } from '../happierCli.js';
import { planLocalHappierCliUpdateRestart } from '../localDaemonCli.js';
import { parseBootstrapChannelParam } from './daemonService.js';

export type CliUpdateTaskResult = Readonly<{
  previousVersion: string;
  version: string;
  /** Whether the service daemon was running and was restarted onto (and proved to run) the new version. */
  restarted: boolean;
}>;

function parseCliUpdateParams(params: unknown) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'CLI update params must be an object.');
  }
  return { releaseRing: parseBootstrapChannelParam((params as Record<string, unknown>).channel) };
}

/**
 * `cli.update.v1` — the desktop's one "Update" action (plan R17/K2, R13 f). Runs the one CLI update
 * transaction on this computer's managed CLI (same progress events as a first acquisition). When
 * this computer's background service is running its daemon, the transaction restarts it through
 * the CLI service owner and proves it runs the new version; if that is not proven, every piece of
 * activation state is restored and the previous version restarted, and the task fails
 * `cli_update_rolled_back`. A daemon that was not running is not started, and a manual daemon is
 * not the service's to restart.
 *
 * Status reads and the restart run with the inherited relay selectors cleared (R13 a): they answer
 * for the relay this home's persisted selection names, which is what the background service
 * serves, so the daemon verified is the daemon restarted even under a stack-pinned launch.
 *
 * One daemon per relay: each pinned service of this home and ring runs the same managed CLI, so
 * each one whose daemon runs is restarted and proven the same way, addressed to that service —
 * through `planServiceDaemonsRestartAfterCliUpdate`, the rule `happier self update` also uses. Every
 * daemon is attempted before a failure is reported. A CLI that cannot list its services leaves
 * only the default-following service in the plan.
 */
export function createCliUpdateHandler() {
  return async function* (
    params: unknown,
    context: Readonly<{ signal: AbortSignal; emit?: (event: unknown) => void }>,
  ): AsyncGenerator<never, CliUpdateTaskResult, void> {
    const { releaseRing } = parseCliUpdateParams(params);
    const onProgress = context.emit ? reportCliAcquisitionProgress(context.emit) : undefined;
    const { previousVersion, cli, restarted } = await updateManagedLocalHappierCli({
      releaseRing,
      signal: context.signal,
      onProgress,
      planRestart: (current) => planLocalHappierCliUpdateRestart({ current, releaseRing, emit: context.emit }),
    });
    context.signal.throwIfAborted();
    return { previousVersion, version: cli.version, restarted };
  };
}
