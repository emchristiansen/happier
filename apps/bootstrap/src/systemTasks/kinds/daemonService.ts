import { systemTasks } from '@happier-dev/cli-common';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import {
  describeUnservedCliChoiceFailure,
  meetsSetupVersionFloor,
  resolveInstalledLocalHappierCli,
  resolveVersionedLocalHappierCli,
} from '../happierCli.js';
import { reportCliAcquisitionProgress } from '../cliAcquisitionProgress.js';
import {
  controlDaemonService,
  daemonStatusServesRelay,
  type DaemonServiceAutostartMode,
  type DaemonStatusSnapshot,
  isDaemonServiceStarted,
  type LocalHappierCliInvocation,
  readDaemonStatus,
  readDaemonServiceStartFailure,
  pinnedServiceServesRelay,
  readAppManagedPinnedServices,
  readPinnedDaemonServices,
  uninstallPinnedService,
  setDaemonServiceAutostart,
  waitForStartedDaemonService,
} from '../localDaemonCli.js';
import { ACCEPTED_BOOTSTRAP_CHANNELS, normalizeBootstrapChannel } from '../taskRuntime.js';
import { listThisComputerServiceRows, type ThisComputerServiceRow } from '../thisComputerServiceRows.js';
import { resolveServingThisComputerService } from '@happier-dev/cli-common/service';

export type DaemonServiceTaskParams = Readonly<{
  target: Readonly<{
    kind: 'local';
  }>;
  /** The app's release ring; selects which managed Happier CLI answers. */
  releaseRing: PublicReleaseRingId;
  surface?: string;
  mode?: 'user';
  /**
   * Only `daemon.service.autostart.set.v1` carries it, and it is never defaulted: the two modes
   * mean opposite things for whether this computer is reachable while the app is closed.
   */
  autostart?: DaemonServiceAutostartMode;
  /**
   * R16 — `daemon.service.start.v1` / `daemon.service.stop.v1` act on the one service that serves
   * this relay (the tray's per-relay rows) instead of every service the app manages.
   */
  relayUrl?: string;
}>;

/**
 * The ambient inspection result. Acquisition is stated explicitly: running this task
 * installs the managed CLI when it is missing, and `acquisition` names the CLI that
 * answered, where it came from, and the version it reports.
 */
type DaemonServiceTaskResult = Readonly<{
  serviceInstalled: boolean;
  daemonRunning: boolean;
  needsAuth: boolean;
  machineId: string | null;
  acquisition: DaemonStatusSnapshot['acquisition'];
  server: DaemonStatusSnapshot['server'];
  auth: DaemonStatusSnapshot['auth'];
  service: DaemonStatusSnapshot['service'];
  daemon: DaemonStatusSnapshot['daemon'];
  runtimeConvergence: DaemonStatusSnapshot['runtimeConvergence'];
  cli: DaemonStatusSnapshot['cli'];
}>;

/**
 * The ambient inspection result: the default-following service's facts (the flat fields and
 * blocks above, unchanged), plus one daemon per relay — each pinned service of this home and ring
 * with its own status, in the same shape. Managed aggregates cover every target before relay-row
 * selection. Completeness states whether the whole inventory was readable; coexistence
 * independently states whether Connect too is supported.
 */
type DaemonServiceStatusTaskResult = DaemonServiceTaskResult & Readonly<{
  /** All installed managed targets, not the selected service on each relay. Null when unknown. */
  runningManagedServiceCount: number | null;
  /** Common mode of all managed targets, including stopped ones; null when empty or unknown. */
  managedServiceAutostart: DaemonServiceAutostartMode | null;
  pinnedServices: Readonly<{
    /** Every listed service was read; `false` means some relay's service is unknown, never absent. */
    complete: boolean;
    coexistence: boolean;
    services: readonly (DaemonServiceTaskResult & Readonly<{ managedBy: 'desktop' | null }>)[];
    unreadable: readonly Readonly<{ relayUrl: string; code: string; message: string }>[];
  }>;
  /** R16 — this computer's services, one row per relay (`listThisComputerServiceRows`). */
  serviceRows: readonly ThisComputerServiceRow[];
}>;

function toDaemonServiceResult(status: DaemonStatusSnapshot): DaemonServiceTaskResult {
  return {
    serviceInstalled: status.serviceInstalled,
    daemonRunning: status.daemonRunning,
    needsAuth: status.needsAuth,
    machineId: status.machineId,
    acquisition: status.acquisition,
    server: status.server,
    auth: status.auth,
    service: status.service,
    daemon: status.daemon,
    runtimeConvergence: status.runtimeConvergence,
    cli: status.cli,
  };
}

/** The preconditions `daemon service start` needs before it can start anything. */
function assertDaemonServiceStartable(status: DaemonStatusSnapshot): void {
  const failure = readDaemonServiceStartFailure(status);
  if (failure) throw new systemTasks.SystemTaskExecutionError(failure.code, failure.message);
}

export function createDaemonServiceStatusHandler() {
  return async function* (
    params: unknown,
    context: Readonly<{ signal: AbortSignal; emit?: (event: unknown) => void }>,
  ): AsyncGenerator<never, DaemonServiceStatusTaskResult, void> {
    const parsed = parseDaemonServiceParams(params);
    const onProgress = context.emit ? reportCliAcquisitionProgress(context.emit) : undefined;
    try {
      const cli = await resolveVersionedLocalHappierCli({ releaseRing: parsed.releaseRing, signal: context.signal, onProgress });
      context.signal.throwIfAborted();
      onProgress?.({ phase: 'checkingDaemon' });
      const [status, pinned] = await Promise.all([
        readDaemonStatus(parsed.releaseRing, cli),
        readPinnedDaemonServices(parsed.releaseRing, cli),
      ]);
      const readablePinned = pinned.items.flatMap((item) => item.status ? [{ status: item.status, managedBy: item.service.managedBy }] : []);
      const unreadablePinned = pinned.items.flatMap((item) => item.error ? [{ relayUrl: item.service.relayUrl, ...item.error }] : []);
      // Relay rows choose one serving target; the global setting/quit must cover all managed ones.
      const managedStatuses = [
        ...(status.serviceInstalled ? [status] : []),
        ...pinned.items.filter((item) => item.service.managedBy === 'desktop').map((item) => item.status),
      ];
      const managedReadable = pinned.listed && managedStatuses.every((entry) => entry !== null);
      const managedModes = managedStatuses.map((entry) => entry?.service.autostart ?? null);
      const firstMode = managedModes[0] ?? null;
      return {
        ...toDaemonServiceResult(status),
        runningManagedServiceCount: managedReadable ? managedStatuses.filter((entry) => entry?.daemonRunning).length : null,
        managedServiceAutostart: managedReadable && firstMode !== null && managedModes.every((mode) => mode === firstMode) ? firstMode : null,
        serviceRows: listThisComputerServiceRows({
          defaultFollowing: status,
          listed: pinned.listed,
          pinned: readablePinned.map((service) => ({ ...service.status, managedBy: service.managedBy })),
          unreadableRelayUrls: unreadablePinned.map((item) => item.relayUrl),
        }),
        pinnedServices: {
          complete: pinned.complete,
          coexistence: pinned.coexistence,
          services: readablePinned.map((service) => ({ ...toDaemonServiceResult(service.status), managedBy: service.managedBy })),
          unreadable: unreadablePinned,
        },
      };
    } catch (error) {
      // R12 — a CLI nobody chose yet (or the kept one) that cannot answer is the question setup
      // still has to ask, not a read to retry.
      throw describeUnservedCliChoiceFailure(error, { releaseRing: parsed.releaseRing }) ?? error;
    }
  };
}

/** The one service here that serves a relay, with the invocation that reaches it. */
type RelayServiceTarget = Readonly<{
  label: string;
  invocation: LocalHappierCliInvocation;
  status: DaemonStatusSnapshot;
}>;

/**
 * R16/D11-2 — the same pinned-first selection the status rows consume. Only a service the app manages may be
 * driven (H2): a pinned one the user set up is refused by name, as is a relay nothing here serves.
 */
async function resolveRelayServiceTarget(
  releaseRing: PublicReleaseRingId,
  cli: LocalHappierCliInvocation,
  relayUrl: string,
): Promise<RelayServiceTarget> {
  const defaultStatus = await readDaemonStatus(releaseRing, cli);
  const snapshot = await readPinnedDaemonServices(releaseRing, cli);
  const selected = resolveServingThisComputerService({
    defaultFollowing: {
      eligible: daemonStatusServesRelay(defaultStatus, relayUrl),
      value: null,
    },
    pinned: snapshot.items.map((item) => ({ eligible: pinnedServiceServesRelay(item.service, relayUrl), value: item })),
  });
  const managed = selected?.value;
  if (managed && managed.service.managedBy !== 'desktop') {
    throw new systemTasks.SystemTaskExecutionError(
      'service_user_owned',
      `This computer's background service for ${relayUrl} was set up outside Happier, so it was left as it is.`,
    );
  }
  if (managed?.status) {
    return { label: managed.status.server.serverUrl ?? relayUrl, invocation: managed.invocation, status: managed.status };
  }
  if (managed || !snapshot.listed) {
    throw new systemTasks.SystemTaskExecutionError('pinned_services_unknown', `The background service for ${relayUrl} could not be read.`);
  }
  if (selected?.serving === 'default-following' && defaultStatus.serviceInstalled) {
    return { label: defaultStatus.server.serverUrl ?? relayUrl, invocation: cli, status: defaultStatus };
  }
  throw new systemTasks.SystemTaskExecutionError('daemon_service_not_found', `This computer has no background service for ${relayUrl}.`);
}

/**
 * What starting one of this computer's services came to. `failed` carries the named reason, so a
 * broken service is reported rather than hidden — and never stops another from starting (M5).
 */
type DaemonServiceStartOutcome = Readonly<{
  /** `default-following`, or the relay URL of a desktop-managed pinned service. */
  target: string;
  outcome: 'started' | 'already_running' | 'failed';
  code?: string;
  message?: string;
}>;

function describeFailure(error: unknown, fallbackCode: string): Readonly<{ code: string; message: string }> {
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : fallbackCode;
  return { code, message: error instanceof Error ? error.message : String(error) };
}

/**
 * "It answers while the app is open": starts every service the app manages — the default-following
 * one and each desktop-managed pinned one — each on its own. A broken or missing service is one
 * failed outcome, never a reason to leave another relay unstarted (M5). The task fails only when
 * nothing could be started at all, with the first failure's code.
 */
export function createDaemonServiceStartHandler() {
  return async function* (
    params: unknown,
    context: Readonly<{ signal: AbortSignal }>,
  ): AsyncGenerator<Readonly<{ type: 'progress'; stepId: string; message?: string }>, DaemonServiceTaskResult & Readonly<{ targets: readonly DaemonServiceStartOutcome[] }>, void> {
    const parsed = parseDaemonServiceParams(params);
    yield {
      type: 'progress',
      stepId: 'task.step.prepare',
      message: 'Inspect daemon service',
    };

    // One acquisition and one version read for the whole run, including the readiness re-reads.
    const cli = await resolveVersionedLocalHappierCli({ releaseRing: parsed.releaseRing });
    if (parsed.relayUrl) {
      const service = await resolveRelayServiceTarget(parsed.releaseRing, cli, parsed.relayUrl);
      yield { type: 'progress', stepId: 'task.step.installRuntime', message: 'Start daemon service' };
      assertDaemonServiceStartable(service.status);
      await controlDaemonService(parsed.releaseRing, { action: 'start', takeover: false }, { ...service.invocation, signal: context.signal });
      const started = await waitForStartedDaemonService({
        readDaemonStatus: () => readDaemonStatus(parsed.releaseRing, service.invocation),
        signal: context.signal,
      });
      if (!isDaemonServiceStarted(started)) {
        throw new systemTasks.SystemTaskExecutionError('daemon_service_not_ready', 'Daemon service did not reach a ready state.');
      }
      yield { type: 'progress', stepId: 'task.step.finish', message: 'Daemon service started' };
      return {
        ...toDaemonServiceResult(started),
        targets: [{ target: service.label, outcome: service.status.daemonRunning ? 'already_running' : 'started' }],
      };
    }
    const currentStatus = await readDaemonStatus(parsed.releaseRing, cli);
    const pinned = await readAppManagedPinnedServices(parsed.releaseRing, cli);

    yield {
      type: 'progress',
      stepId: 'task.step.installRuntime',
      message: 'Start daemon service',
    };

    const targets: DaemonServiceStartOutcome[] = [];
    let latestDefault = currentStatus;
    try {
      assertDaemonServiceStartable(currentStatus);
      await controlDaemonService(parsed.releaseRing, { action: 'start', takeover: false }, { ...cli, signal: context.signal });
      latestDefault = await waitForStartedDaemonService({
        readDaemonStatus: () => readDaemonStatus(parsed.releaseRing, cli),
        signal: context.signal,
      });
      if (!isDaemonServiceStarted(latestDefault)) {
        throw new systemTasks.SystemTaskExecutionError('daemon_service_not_ready', 'Daemon service did not reach a ready state.');
      }
      targets.push({ target: 'default-following', outcome: currentStatus.daemonRunning ? 'already_running' : 'started' });
    } catch (error) {
      context.signal.throwIfAborted();
      targets.push({ target: 'default-following', outcome: 'failed', ...describeFailure(error, 'daemon_service_not_ready') });
    }

    for (const service of pinned.services) {
      const relayUrl = service.status.server.serverUrl ?? 'pinned';
      if (!service.status.serviceInstalled || service.status.daemonRunning) {
        if (service.status.daemonRunning) targets.push({ target: relayUrl, outcome: 'already_running' });
        continue;
      }
      try {
        assertDaemonServiceStartable(service.status);
        await controlDaemonService(parsed.releaseRing, { action: 'start', takeover: false }, { ...service.invocation, signal: context.signal });
        targets.push({ target: relayUrl, outcome: 'started' });
      } catch (error) {
        context.signal.throwIfAborted();
        targets.push({ target: relayUrl, outcome: 'failed', ...describeFailure(error, 'daemon_service_not_ready') });
      }
    }
    for (const relayUrl of pinned.unreadable) {
      targets.push({ target: relayUrl, outcome: 'failed', code: 'pinned_services_unknown', message: 'The background service for this relay could not be read.' });
    }
    if (!pinned.complete && pinned.unreadable.length === 0) {
      targets.push({ target: 'pinned', outcome: 'failed', code: 'pinned_services_unknown', message: 'This computer\'s other background services could not be listed.' });
    }

    for (const failure of targets.filter((entry) => entry.outcome === 'failed')) {
      yield {
        type: 'progress',
        stepId: 'task.step.installRuntime',
        message: `Could not start the background service for ${failure.target}: ${failure.message ?? failure.code ?? 'unknown error'}`,
      };
    }
    // N3 — success means this computer's default-following service is up, or this run started
    // something. A service that was already running is not something this start did, so it never
    // hides the default-following service's own failure.
    const defaultOutcome = targets[0];
    if (defaultOutcome?.outcome === 'failed' && !targets.some((entry) => entry.outcome === 'started')) {
      throw new systemTasks.SystemTaskExecutionError(defaultOutcome.code ?? 'daemon_service_not_ready', defaultOutcome.message ?? 'Daemon service did not reach a ready state.');
    }

    yield {
      type: 'progress',
      stepId: 'task.step.finish',
      message: 'Daemon service started',
    };

    return { ...toDaemonServiceResult(latestDefault), targets };
  };
}

/**
 * Desktop closes: with login start off the app stops the background service as it quits, so the
 * computer does not keep answering for an app the user has closed. The stop itself belongs to the
 * CLI; this handler sequences it and then proves it by re-reading, never by the command's success.
 */
export function createDaemonServiceStopHandler() {
  return async function* (
    params: unknown,
    context: Readonly<{ signal: AbortSignal }>,
  ): AsyncGenerator<Readonly<{ type: 'progress'; stepId: string; message?: string }>, DaemonServiceTaskResult, void> {
    const parsed = parseDaemonServiceParams(params);
    yield {
      type: 'progress',
      stepId: 'task.step.prepare',
      message: 'Stop daemon service',
    };

    // One acquisition and one version read for the whole run: the command that stops the service
    // and the read that proves it stopped must be the same CLI.
    const cli = await resolveVersionedLocalHappierCli({ releaseRing: parsed.releaseRing });
    if (parsed.relayUrl) {
      const service = await resolveRelayServiceTarget(parsed.releaseRing, cli, parsed.relayUrl);
      await controlDaemonService(parsed.releaseRing, { action: 'stop', takeover: false }, { ...service.invocation, signal: context.signal });
      const stopped = await readDaemonStatus(parsed.releaseRing, service.invocation);
      if (stopped.daemonRunning || stopped.service.running) {
        throw new systemTasks.SystemTaskExecutionError(
          'daemon_service_still_running',
          `The background service for ${service.label} is still running after the stop command.`,
        );
      }
      yield { type: 'progress', stepId: 'task.step.finish', message: 'Daemon service stopped' };
      return toDaemonServiceResult(stopped);
    }
    const status = await applyManagedServiceChanges(parsed.releaseRing, cli, context.signal, { action: 'stop' });

    yield {
      type: 'progress',
      stepId: 'task.step.finish',
      message: 'Daemon service stopped',
    };

    return toDaemonServiceResult(status);
  };
}

/**
 * Whether the installed service starts at login. The CLI owns every platform rule; this handler
 * states the intent and re-reads the installed definition, so a CLI that cannot express the mode
 * fails by name instead of leaving the toggle claiming something the computer will not do.
 */
export function createDaemonServiceAutostartSetHandler() {
  return async function* (
    params: unknown,
    context: Readonly<{ signal: AbortSignal }>,
  ): AsyncGenerator<Readonly<{ type: 'progress'; stepId: string; message?: string }>, DaemonServiceTaskResult, void> {
    const parsed = parseDaemonServiceAutostartParams(params);
    yield {
      type: 'progress',
      stepId: 'task.step.prepare',
      message: parsed.autostart === 'at-login'
        ? 'Start the background service at login'
        : 'Stop starting the background service at login',
    };

    const cli = await resolveVersionedLocalHappierCli({ releaseRing: parsed.releaseRing });
    const status = await applyManagedServiceChanges(parsed.releaseRing, cli, context.signal, { action: 'autostart', autostart: parsed.autostart });

    yield {
      type: 'progress',
      stepId: 'task.step.finish',
      message: 'Login start updated',
    };

    return toDaemonServiceResult(status);
  };
}

/**
 * H3 — this computer stops answering on one relay: the service the app installed for it ("connect to
 * this relay too") is uninstalled through the CLI, and the result is proven by listing again. A
 * service the user set up is never touched (`service_user_owned`); a relay with no service of its
 * own here has nothing to remove. Removing a relay in Settings runs this before any credential or
 * profile is deleted, and stops if it fails.
 */
export function createDaemonServiceRelayDisconnectHandler() {
  return async function* (
    params: unknown,
    context: Readonly<{ signal: AbortSignal }>,
  ): AsyncGenerator<Readonly<{ type: 'progress'; stepId: string; message?: string }>, Readonly<{ removed: boolean }>, void> {
    const parsed = parseDaemonServiceParams(params);
    const relayUrl = typeof (params as { relayUrl?: unknown }).relayUrl === 'string' ? (params as { relayUrl: string }).relayUrl.trim() : '';
    if (!relayUrl) {
      throw new systemTasks.SystemTaskExecutionError('invalid_params', 'relayUrl is required.');
    }
    // R10-1 — only what is already on this computer: a CLI downloaded now could not have installed
    // anything, and removing a relay must never wait on a download.
    const installed = await resolveInstalledLocalHappierCli({ releaseRing: parsed.releaseRing, signal: context.signal });
    if (!installed) {
      return { removed: false };
    }
    const cli = { ...installed, signal: context.signal };
    const snapshot = await readPinnedDaemonServices(parsed.releaseRing, cli);
    if (!snapshot.listed) {
      // A CLI below the setup floor never created a desktop-managed service (setup cannot run on
      // it); on one at the floor, a list that fails is a real unknown, named for the app to ask.
      if (!meetsSetupVersionFloor(cli.version)) {
        return { removed: false };
      }
      throw new systemTasks.SystemTaskExecutionError('pinned_services_unknown', 'This computer\'s background services could not be listed, so nothing was removed.');
    }
    const serving = snapshot.items.filter((item) => pinnedServiceServesRelay(item.service, relayUrl));
    if (serving.some((item) => item.service.managedBy !== 'desktop')) {
      throw new systemTasks.SystemTaskExecutionError(
        'service_user_owned',
        `This computer's background service for ${relayUrl} was set up outside Happier, so it was left as it is.`,
      );
    }
    if (serving.length === 0) {
      return { removed: false };
    }
    yield { type: 'progress', stepId: 'task.step.installRuntime', message: 'Disconnect this computer from the relay' };
    for (const item of serving) {
      await uninstallPinnedService(parsed.releaseRing, item);
    }
    const after = await readPinnedDaemonServices(parsed.releaseRing, cli);
    if (!after.listed || after.items.some((item) => pinnedServiceServesRelay(item.service, relayUrl))) {
      throw new systemTasks.SystemTaskExecutionError(
        'daemon_service_still_installed',
        `This computer's background service for ${relayUrl} is still installed after the uninstall command.`,
      );
    }
    return { removed: true };
  };
}

/**
 * F4/M6 — a stop or a login-start change that could not reach every service the app manages is a
 * failure by name, never "done": the services it could read were handled first, and the ones it
 * could not are named.
 */
async function applyManagedServiceChanges(
  releaseRing: PublicReleaseRingId,
  cli: LocalHappierCliInvocation,
  signal: AbortSignal,
  change: Readonly<{ action: 'stop' }> | Readonly<{ action: 'autostart'; autostart: DaemonServiceAutostartMode }>,
): Promise<DaemonStatusSnapshot> {
  const failures: { target: string; code: string; message: string }[] = [];
  const recordFailure = (target: string, error: unknown) => {
    signal.throwIfAborted();
    failures.push({ target, ...describeFailure(error, 'daemon_service_change_failed') });
  };
  const invocation = { ...cli, signal };
  let latestDefault: DaemonStatusSnapshot | null = null;
  try {
    latestDefault = await readDaemonStatus(releaseRing, invocation);
  } catch (error) {
    recordFailure('default-following', error);
  }
  const managed = await readAppManagedPinnedServices(releaseRing, invocation);
  const targets = [
    ...(latestDefault ? [{ target: 'default-following', invocation, status: latestDefault }] : []),
    ...managed.services.map((service) => ({ ...service, target: service.status.server.serverUrl ?? 'pinned' })),
  ];
  // M5's attempt-all pattern: one failed target never prevents a later managed relay settling.
  for (const service of targets) {
    signal.throwIfAborted();
    if (change.action === 'autostart' && !service.status.serviceInstalled) continue;
    if (change.action === 'stop' && !service.status.serviceInstalled) continue;
    const scoped = { ...service.invocation, signal };
    let commandFailure: ReturnType<typeof describeFailure> | null = null;
    try {
      if (change.action === 'stop') {
        await controlDaemonService(releaseRing, { action: 'stop', takeover: false }, scoped);
      } else {
        await setDaemonServiceAutostart(releaseRing, change.autostart, scoped);
      }
    } catch (error) {
      signal.throwIfAborted();
      commandFailure = describeFailure(error, 'daemon_service_change_failed');
    }
    // Re-read even a failed command: it may already have changed the installed service.
    try {
      const status = await readDaemonStatus(releaseRing, scoped);
      if (service.target === 'default-following') latestDefault = status;
      if (change.action === 'stop' && (status.daemonRunning || status.service.running)) {
        throw new systemTasks.SystemTaskExecutionError('daemon_service_still_running', 'The background service is still running after the stop command.');
      }
      if (change.action === 'autostart') {
        if (status.service.autostart === null) {
          throw new systemTasks.SystemTaskExecutionError('daemon_service_autostart_unsupported', 'The installed Happier CLI does not report the background service autostart mode.');
        }
        if (status.service.autostart !== change.autostart) {
          throw new systemTasks.SystemTaskExecutionError('daemon_service_autostart_not_applied', 'The background service still declares a different autostart mode than requested.');
        }
      }
    } catch (error) {
      if (commandFailure) failures.push({ target: service.target, ...commandFailure });
      recordFailure(service.target, error);
    }
  }
  if (!managed.complete) {
    failures.push({ target: managed.unreadable.join(', ') || 'pinned', code: 'pinned_services_unknown', message: 'The background services could not be read, so they were left as they are.' });
  }
  if (failures.length > 0) {
    throw new systemTasks.SystemTaskExecutionError(failures[0]!.code, failures.map((failure) => `${failure.target}: ${failure.message}`).join('\n'));
  }
  if (!latestDefault) throw new systemTasks.SystemTaskExecutionError('status_unavailable', 'The default-following service could not be read.');
  return latestDefault;
}

export function parseDaemonServiceParams(params: unknown): DaemonServiceTaskParams {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'Daemon service params must be an object.');
  }
  const record = params as Record<string, unknown>;
  const target = record.target;
  const mode = record.mode;

  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'target is required.');
  }
  const targetRecord = target as Record<string, unknown>;
  const kind = typeof targetRecord.kind === 'string' ? targetRecord.kind.trim() : '';
  if (kind !== 'local') {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'Only local daemon targets are supported.');
  }

  const normalizedMode = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
  if (normalizedMode && normalizedMode !== 'user') {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'mode must be "user" when provided.');
  }

  const surface = record.surface;
  if (surface !== undefined && (typeof surface !== 'string' || surface.trim().length === 0)) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'surface must be a non-empty string when provided.');
  }

  const autostart = record.autostart;
  if (autostart !== undefined && autostart !== 'at-login' && autostart !== 'on-demand') {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'autostart must be at-login or on-demand when provided.');
  }

  const relayUrl = record.relayUrl;
  if (relayUrl !== undefined && (typeof relayUrl !== 'string' || relayUrl.trim().length === 0)) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'relayUrl must be a non-empty string when provided.');
  }

  return {
    target: {
      kind: 'local',
    },
    releaseRing: parseBootstrapChannelParam(record.channel),
    ...(surface === undefined ? {} : { surface: surface.trim() }),
    ...(normalizedMode === 'user' ? { mode: 'user' as const } : {}),
    ...(autostart === undefined ? {} : { autostart }),
    ...(relayUrl === undefined ? {} : { relayUrl: relayUrl.trim() }),
  };
}

/**
 * The ring the caller asked for, or a failure. `normalizeBootstrapChannel` maps anything it does
 * not recognise to `stable`, which would read or start the wrong ring's CLI for a typo'd ring —
 * the same reason `parseSetupThisComputerParams` rejects one. An absent channel keeps the default.
 */
export function parseBootstrapChannelParam(value: unknown): PublicReleaseRingId {
  if (value === undefined || value === null) {
    return normalizeBootstrapChannel(undefined).releaseChannel;
  }
  const channel = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!ACCEPTED_BOOTSTRAP_CHANNELS.includes(channel)) {
    throw new systemTasks.SystemTaskExecutionError(
      'invalid_params',
      `channel must be one of ${ACCEPTED_BOOTSTRAP_CHANNELS.join(', ')} when provided.`,
    );
  }
  return normalizeBootstrapChannel(channel).releaseChannel;
}

/**
 * The autostart sibling shares the family parser and adds the one field that must not be
 * defaulted. A missing `autostart` is a caller bug, not "leave it off".
 */
export function parseDaemonServiceAutostartParams(
  params: unknown,
): DaemonServiceTaskParams & Readonly<{ autostart: DaemonServiceAutostartMode }> {
  const parsed = parseDaemonServiceParams(params);
  if (parsed.autostart === undefined) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'autostart is required.');
  }
  return { ...parsed, autostart: parsed.autostart };
}
