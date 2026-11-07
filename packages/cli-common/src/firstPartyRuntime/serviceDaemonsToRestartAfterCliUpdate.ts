import type { ManagedCliUpdateRestart } from './runManagedCliUpdate.js';

/**
 * One background service of the Happier home and ring being updated, as observed BEFORE the
 * update — on Windows the update stops the payload's processes first, so only this observation
 * still knows which daemons must come back.
 */
export type ServiceDaemonBeforeCliUpdate<T> = Readonly<{
  /** Names the service in the failure report (its service label or instance). */
  label: string;
  serviceInstalled: boolean;
  daemonRunning: boolean;
  /** The service itself started the running daemon (not a manual or another CLI's daemon). */
  serviceManaged: boolean;
  /**
   * A pinned service's management marker. `desktop` (or the default-following service) is the
   * update's own; an unmarked pinned service is the user's.
   */
  managedBy?: 'desktop' | null;
  /**
   * The command that restarts exactly this service by hand (see
   * `formatPinnedDaemonServiceRestartCommand`), named when a user-owned one does not come back.
   */
  restartCommand?: string;
  /** Whatever the caller needs to address this service's restart. */
  target: T;
}>;

export type ServiceDaemonsRestartAfterCliUpdatePlan = Readonly<{
  /** The services whose daemons the update restarts, in restart order. */
  labels: readonly string[];
  /** The update transaction's restart step, or `null` when no service daemon was running. */
  restart: ManagedCliUpdateRestart | null;
}>;

/**
 * The hand-run restart of one pinned service: its relay profile (`--server`, so a drift refresh
 * keeps the definition on that relay) and its instance (`--instance=`; without it `service restart`
 * addresses the default-following service).
 */
export function formatPinnedDaemonServiceRestartCommand(params: Readonly<{
  /** The ring's managed CLI command (`happier`, `hprev`, `hdev`). */
  toolName: string;
  serverId: string;
  instanceId: string;
}>): string {
  return `${params.toolName} --server ${params.serverId} service restart --instance=${params.instanceId}`;
}

function describeUnownedRestartFailure(params: Readonly<{
  label: string;
  expectedVersion: string;
  reason: string;
  restartCommand?: string;
}>): string {
  const hint = params.restartCommand ? ` Start it with: ${params.restartCommand}` : '';
  return `A background service you installed (${params.label}) did not come back on ${params.expectedVersion} (${params.reason}); the update was kept.${hint}`;
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message.trim() : String(error);
}

/**
 * The one rule for which daemons a managed CLI update restarts (plan R13 f; one daemon per relay):
 * the default-following service and every pinned service of this Happier home and ring whose own
 * service was running its daemon before the update. `happier self update` (terminal or remote) and
 * the desktop's `cli.update.v1` both build their restart step here; only how they observe the
 * services differs (in-process vs through the CLI's JSON).
 *
 * The step restarts every selected daemon and proves each one (`restartAndProve` throws when a
 * daemon does not come back on `expectedVersion`), attempting all of them before reporting, so
 * one failure never leaves another relay's daemon stopped.
 *
 * Whether the update itself succeeded is judged only by the services the update owns — the
 * default-following service and pinned services the desktop manages (`managedBy: desktop`). A
 * failure there fails the step, naming each such label, so the transaction rolls back and runs
 * this same step for the previous version. A user-owned pinned service is still restarted
 * (restoring what the update stopped), but its failure is named through
 * `reportUnownedRestartFailure` and never rolls the update back.
 */
export function planServiceDaemonsRestartAfterCliUpdate<T>(params: Readonly<{
  defaultFollowing: ServiceDaemonBeforeCliUpdate<T> | null;
  pinned: readonly ServiceDaemonBeforeCliUpdate<T>[];
  restartAndProve: (target: T, expectedVersion: string) => Promise<void>;
  /**
   * A user-owned service did not come back; `message` is the complete user-facing sentence (with
   * the exact restart command when the candidate carried one). The consumer must surface it.
   */
  reportUnownedRestartFailure: (message: string) => void;
}>): ServiceDaemonsRestartAfterCliUpdatePlan {
  const selected: Array<ServiceDaemonBeforeCliUpdate<T> & Readonly<{ owned: boolean }>> = [];
  const candidates = [
    ...(params.defaultFollowing ? [{ ...params.defaultFollowing, owned: true }] : []),
    ...params.pinned.map((service) => ({ ...service, owned: service.managedBy === 'desktop' })),
  ];
  for (const service of candidates) {
    if (!service.serviceInstalled || !service.daemonRunning || !service.serviceManaged) continue;
    if (selected.some((entry) => entry.label === service.label)) continue;
    selected.push(service);
  }
  if (selected.length === 0) {
    return { labels: [], restart: null };
  }
  return {
    labels: selected.map((service) => service.label),
    restart: async ({ expectedVersion }) => {
      const ownedFailures: string[] = [];
      for (const service of selected) {
        try {
          await params.restartAndProve(service.target, expectedVersion);
        } catch (error) {
          if (service.owned) {
            ownedFailures.push(`${service.label}: ${describeError(error)}`);
          } else {
            params.reportUnownedRestartFailure(describeUnownedRestartFailure({
              label: service.label,
              expectedVersion,
              reason: describeError(error),
              restartCommand: service.restartCommand,
            }));
          }
        }
      }
      if (ownedFailures.length > 0) {
        throw new Error(ownedFailures.join('; '));
      }
    },
  };
}
