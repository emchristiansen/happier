import { AGENTS_CORE } from '@happier-dev/agents';
import type { ConnectedServiceBindingsV1 } from '@happier-dev/protocol';

import { prepareExecutionRunConnectedServices } from '@/agent/executionRuns/runtime/prepareExecutionRunConnectedServices';
import { parseConnectedServicesLaunchAuth, resolveConnectedServicesLaunchAuth } from '@/cli/connectedServicesLaunchAuth';
import {
  materializeDaemonConnectedServicesForExecutionRun,
  releaseDaemonConnectedServicesForExecutionRun,
} from '@/daemon/controlClient';
import { readDaemonState, type DaemonLocallyPersistedState } from '@/persistence';
import { logger } from '@/ui/logger';

/**
 * A Claude subscription profile prepared for a NATIVE `claude` process that runs outside any Happier
 * session (the scheduled private-report delivery test). The daemon stays the sole owner: `materialize`
 * sends the one explicit, inventory-checked profile through the existing execution-run bridge, which
 * refreshes the credential if needed, writes the profile's Claude home and keeps it registered (so
 * later refreshes reach it) until `release`.
 *
 * The registration is anchored to the pid of the daemon that admits it, never to this short-lived command
 * or the native caller. The daemon resolves a registration's pid against its tracked sessions (credential
 * deletion stops, required restarts), and only a tracked child's exit prunes it, so an anchor that dies
 * before release (SIGKILL, unreachable daemon) could later be reused by an unrelated tracked session that
 * a deletion of this profile would stop. The daemon publication is therefore read ONCE, and that one
 * snapshot supplies the anchor pid and pins both requests' endpoint and control token. Every daemon start
 * mints a fresh control token, so a replacement daemon rejects the pinned requests (or the old endpoint
 * is gone) instead of admitting a registration under its predecessor's pid, whatever happens to cleanup
 * afterwards. A registration therefore names only the pid of the live daemon holding it, which is never
 * a tracked session and cannot be reused while that daemon, and with it the in-memory registration,
 * lives. This rests on the daemon's per-start token, not on a later check.
 *
 * Nothing here reads, prints or returns credential values; the caller learns only that the home it will
 * launch with is the one the daemon prepared.
 * The run-start decision lines go to the log file only, so stdout carries just the readiness record.
 */

export type NativeConnectedServicesErrorCode =
  | 'native_connected_services_selection_invalid'
  | 'native_connected_services_daemon_unavailable'
  | 'native_connected_services_inventory_unavailable'
  | 'native_connected_services_not_materialized'
  | 'native_connected_services_expectation_failed'
  | 'native_connected_services_release_failed';

export class NativeConnectedServicesError extends Error {
  readonly code: NativeConnectedServicesErrorCode;
  readonly cause?: unknown;

  constructor(code: NativeConnectedServicesErrorCode, message: string, options?: Readonly<{ cause?: unknown }>) {
    super(`${code}: ${message}`);
    this.name = 'NativeConnectedServicesError';
    this.code = code;
    this.cause = options?.cause;
  }
}

const AGENT_ID = 'claude' as const;
const FILE_ONLY_DECISION_LOG = {
  info: (message: string, ...args: unknown[]) => logger.infoFile(message, ...args),
  warn: (message: string, ...args: unknown[]) => logger.warnFile(message, ...args),
};
const SERVICE_ID = 'claude-subscription' as const;

export type NativeClaudeReadiness = Readonly<{
  v: 1;
  status: 'ready';
  agentId: typeof AGENT_ID;
  serviceId: typeof SERVICE_ID;
  profileId: string;
  /** The run key to pass to `release` once the native process has finished. */
  materializationKey: string;
}>;

type MaterializeViaDaemon = typeof materializeDaemonConnectedServicesForExecutionRun;
type ReleaseViaDaemon = (
  body: Readonly<{ runId: string; pid: number; materializationKey: string }>,
) => Promise<boolean>;

export async function materializeClaudeProfileForNativeProcess(
  request: Readonly<{
    profileId: string;
    /** The CLAUDE_CONFIG_DIR the native process will run with; the daemon's home must equal it. */
    expectedConfigDir: string;
    /** The native process's working directory. */
    cwd: string;
  }>,
  deps: Readonly<{
    listInventory: () => Promise<unknown>;
    materializeViaDaemon?: MaterializeViaDaemon;
    releaseViaDaemon?: ReleaseViaDaemon;
    /** The published daemon (pid, endpoint, control token), read once; defaults to the daemon state file. */
    readDaemonPublication?: () => Promise<DaemonLocallyPersistedState | null>;
  }>,
): Promise<NativeClaudeReadiness> {
  const readDaemonPublication = deps.readDaemonPublication ?? readDaemonState;
  const supportedServiceIds = AGENTS_CORE[AGENT_ID].connectedServices?.supportedServiceIds ?? [];
  let inventory: unknown;
  try {
    inventory = await deps.listInventory();
  } catch (error) {
    throw new NativeConnectedServicesError(
      'native_connected_services_inventory_unavailable',
      'the account connected-service inventory could not be read',
      { cause: error },
    );
  }
  let bindings: ConnectedServiceBindingsV1 | null;
  try {
    // The canonical selector grammar and inventory check: exactly one selectable profile, or an error.
    bindings = resolveConnectedServicesLaunchAuth({
      intent: parseConnectedServicesLaunchAuth(`cs:${SERVICE_ID}:profile:${request.profileId}`),
      supportedServiceIds,
      inventory,
    });
  } catch (error) {
    throw new NativeConnectedServicesError(
      'native_connected_services_selection_invalid',
      error instanceof Error ? error.message : 'selection not resolvable',
      { cause: error },
    );
  }
  if (!bindings) {
    throw new NativeConnectedServicesError('native_connected_services_selection_invalid', 'selection resolved to no binding');
  }

  const daemonPublication = await readDaemonPublication();
  if (!daemonPublication?.httpPort || !daemonPublication.controlToken) {
    throw new NativeConnectedServicesError('native_connected_services_daemon_unavailable', 'no running daemon is published');
  }
  // Both requests go to exactly this daemon generation; see the module comment.
  const pinned = { daemonPublication } as const;
  const materializeViaDaemon: MaterializeViaDaemon = deps.materializeViaDaemon
    ?? (async (body, options) => await materializeDaemonConnectedServicesForExecutionRun(body, { ...options, ...pinned }));
  const releaseViaDaemon: ReleaseViaDaemon = deps.releaseViaDaemon
    ?? (async (body) => await releaseDaemonConnectedServicesForExecutionRun(body, pinned));

  let prepared: Awaited<ReturnType<typeof prepareExecutionRunConnectedServices>>;
  try {
    prepared = await prepareExecutionRunConnectedServices({
      backendTarget: { kind: 'builtInAgent', agentId: AGENT_ID },
      connectedServices: bindings,
      // No credentials: the explicit binding is the only selection; nothing may fall back to a default.
      credentials: null,
      cwd: request.cwd,
      registrationPid: daemonPublication.pid,
      decisionLog: FILE_ONLY_DECISION_LOG,
      materializeViaDaemon,
      releaseViaDaemon,
    });
  } catch (error) {
    // prepare has already attempted the idempotent release of the run key, including after an abandoned
    // (timed-out) call. That release is best-effort and can fail; a registration it leaves behind stays
    // anchored to the admitting daemon's pid until a later release or that daemon's exit.
    throw new NativeConnectedServicesError(
      'native_connected_services_not_materialized',
      'the daemon did not materialize the selection',
      { cause: error },
    );
  }
  if (!prepared) {
    throw new NativeConnectedServicesError(
      'native_connected_services_not_materialized',
      'the selection resolved to no connected binding',
    );
  }

  if (prepared.env.CLAUDE_CONFIG_DIR !== request.expectedConfigDir) {
    await prepared.cleanup();
    throw new NativeConnectedServicesError(
      'native_connected_services_expectation_failed',
      'the daemon prepared a different Claude home than the expected config dir',
    );
  }

  return {
    v: 1,
    status: 'ready',
    agentId: AGENT_ID,
    serviceId: SERVICE_ID,
    profileId: request.profileId,
    materializationKey: prepared.materializationKey,
  };
}


export async function releaseClaudeProfileForNativeProcess(
  request: Readonly<{ materializationKey: string }>,
  deps: Readonly<{ releaseViaDaemon?: ReleaseViaDaemon }> = {},
): Promise<void> {
  const release = deps.releaseViaDaemon ?? releaseDaemonConnectedServicesForExecutionRun;
  const released = await release({
    runId: request.materializationKey,
    pid: process.pid,
    materializationKey: request.materializationKey,
  });
  if (!released) {
    throw new NativeConnectedServicesError(
      'native_connected_services_release_failed',
      `the daemon did not confirm release of ${request.materializationKey}`,
    );
  }
}

export type ConnectNativeCommand =
  | Readonly<{ kind: 'materialize'; profileId: string; expectedConfigDir: string; json: boolean }>
  | Readonly<{ kind: 'release'; materializationKey: string }>;

const MATERIALIZATION_KEY = /^execution_run:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function invalidArgs(message: string): NativeConnectedServicesError {
  return new NativeConnectedServicesError('native_connected_services_selection_invalid', message);
}

/**
 * Parses `connect materialize claude --profile <id> --expect-config-dir <path> [--json]` and
 * `connect release --materialization-key <key>`. Every flag is known and every value explicit.
 */
export function parseConnectNativeArgs(args: ReadonlyArray<string>): ConnectNativeCommand {
  const [subcommand, ...afterSubcommand] = args;
  let rest = afterSubcommand;
  if (subcommand === 'materialize') {
    if (rest[0] !== AGENT_ID) throw invalidArgs('materialize supports only claude');
    rest = rest.slice(1);
  } else if (subcommand !== 'release') {
    throw invalidArgs('expected materialize or release');
  }
  const allowed = subcommand === 'materialize' ? ['--profile', '--expect-config-dir'] : ['--materialization-key'];
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]!;
    if (flag === '--json' && subcommand === 'materialize' && !json) {
      json = true;
      continue;
    }
    const value = rest[index + 1];
    if (!allowed.includes(flag) || values.has(flag) || value === undefined || !value.trim() || value.startsWith('-')) {
      throw invalidArgs(`unexpected argument ${JSON.stringify(flag)}`);
    }
    values.set(flag, value);
    index += 1;
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined) throw invalidArgs(`${flag} is required`);
    return value;
  };

  if (subcommand === 'release') {
    const materializationKey = required('--materialization-key');
    if (!MATERIALIZATION_KEY.test(materializationKey)) throw invalidArgs('--materialization-key is not a run key');
    return { kind: 'release', materializationKey };
  }
  const expectedConfigDir = required('--expect-config-dir');
  if (!expectedConfigDir.startsWith('/')) throw invalidArgs('--expect-config-dir must be an absolute path');
  return { kind: 'materialize', profileId: required('--profile'), expectedConfigDir, json };
}
