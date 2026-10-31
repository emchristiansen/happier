import { createHash, randomUUID } from 'node:crypto';

import { systemTasks } from '@happier-dev/cli-common';
import type { SystemTaskJsonObject, SystemTaskJsonValue } from '@happier-dev/protocol';

import { createSecureAccessTailscaleHandler } from './kinds/secureAccessTailscale.js';
import { createCliPathExposureEnsureHandler, createCliPathExposureRemoveHandler } from './kinds/cliPathExposure.js';
import { createCliUpdateHandler } from './kinds/cliUpdate.js';
import {
  createDaemonServiceAutostartSetHandler,
  createDaemonServiceStartHandler,
  createDaemonServiceStatusHandler,
  createDaemonServiceRelayDisconnectHandler,
  createDaemonServiceStopHandler,
} from './kinds/daemonService.js';
import { checkRelayRuntimeHealthDefault, controlRelayRuntimeDefault, installOrUpdateRelayRuntimeDefault, readRelayRuntimeStatusDefault } from './relayRuntimeTasks.js';

function stableStringify(value: SystemTaskJsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const objectValue = value as SystemTaskJsonObject;
  const keys = Object.keys(objectValue).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`).join(',')}}`;
}

function digestParams(params: SystemTaskJsonValue): string {
  return createHash('sha256').update(stableStringify(params)).digest('hex');
}

type SystemTaskRegistry = ReturnType<typeof systemTasks.createSystemTaskRegistry>;

type HsetupRegistryDeps = Readonly<{
  relayRuntime?: Partial<RelayRuntimeDeps>;
}>;

type RelayRuntimeDeps = Readonly<{
  readStatus: (params: systemTasks.RelayRuntimeTaskParams) => Promise<systemTasks.RelayRuntimeStatusSnapshot>;
  checkHealth: (params: Readonly<{ baseUrl: string }>) => Promise<boolean>;
  installOrUpdate: (params: systemTasks.RelayRuntimeTaskParams) => Promise<Readonly<{ relayUrl: string; mode: 'user' | 'system' }>>;
  control: (params: systemTasks.RelayRuntimeTaskParams & Readonly<{ action: 'start' | 'stop' | 'restart' }>) => Promise<void>;
}>;

/**
 * The kinds `runHsetupCli` dispatches through `executeSystemTask`. A kind that also lives in
 * `createDefaultInteractiveKinds()` must not appear here: the interactive map wins for every kind
 * it holds, so a registry twin is an entry nothing can reach (INV1).
 */
export function createHsetupSystemTaskRegistry(deps: HsetupRegistryDeps = {}): SystemTaskRegistry {
  const relayRuntimeDeps = createRelayRuntimeDeps(deps.relayRuntime);
  const relayRuntimeStatusHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createRelayRuntimeStatusTaskKind(relayRuntimeDeps),
  );
  const relayRuntimeInstallHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createRelayRuntimeInstallOrUpdateTaskKind(relayRuntimeDeps),
  );
  const relayRuntimeStartHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createRelayRuntimeStartTaskKind(relayRuntimeDeps),
  );
  const relayRuntimeStopHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createRelayRuntimeStopTaskKind(relayRuntimeDeps),
  );
  const daemonServiceStatusHandler = createDaemonServiceStatusHandler();
  const daemonServiceStartHandler = createDaemonServiceStartHandler();

  return systemTasks.createSystemTaskRegistry([
    {
      kind: 'daemon.service.status.v1',
      handler: daemonServiceStatusHandler,
    },
    {
      kind: 'daemon.service.start.v1',
      handler: daemonServiceStartHandler,
    },
    {
      kind: 'daemon.service.stop.v1',
      handler: createDaemonServiceStopHandler(),
    },
    {
      kind: 'daemon.service.relay.disconnect.v1',
      handler: createDaemonServiceRelayDisconnectHandler(),
    },
    {
      kind: 'daemon.service.autostart.set.v1',
      handler: createDaemonServiceAutostartSetHandler(),
    },
    {
      kind: 'cli.pathExposure.ensure.v1',
      handler: createCliPathExposureEnsureHandler(),
    },
    {
      kind: 'cli.pathExposure.remove.v1',
      handler: createCliPathExposureRemoveHandler(),
    },
    {
      kind: 'cli.update.v1',
      handler: createCliUpdateHandler(),
    },
    {
      kind: 'system.noop.v1',
      handler: async function* (params, context) {
        const parsed = parseNoopParams(params);

        yield {
          type: 'progress',
          stepId: 'noop',
          message: 'noop started',
        };

        await waitForDelay(parsed.delayMs ?? 0, context.signal);

        return {
          kind: 'system.noop.v1',
          status: 'completed',
        };
      },
    },
    {
      kind: 'system.ping.v1',
      handler: async function* (params) {
        const parsedParams = params as SystemTaskJsonValue;
        const paramDigest = digestParams(parsedParams);

        yield {
          type: 'progress',
          stepId: 'ping',
          message: 'ping acknowledged',
          data: {
            kind: 'system.ping.v1',
            paramDigest,
          },
        };

        return {
          acknowledged: true,
          kind: 'system.ping.v1',
          paramDigest,
        };
      },
    },
    {
      kind: 'relay.runtime.status.v1',
      handler: relayRuntimeStatusHandler,
    },
    {
      kind: 'relay.runtime.installOrUpdate.v1',
      handler: relayRuntimeInstallHandler,
    },
    {
      kind: 'relay.runtime.start.v1',
      handler: relayRuntimeStartHandler,
    },
    {
      kind: 'relay.runtime.stop.v1',
      handler: relayRuntimeStopHandler,
    },
    {
      kind: 'secureAccess.tailscale.v1',
      handler: createSecureAccessTailscaleHandler(),
    },
  ]);
}
export function createSystemTaskId(): string {
  return `system_task_${randomUUID()}`;
}

async function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return;
  if (signal.aborted) {
    throw new systemTasks.SystemTaskExecutionError('cancelled', 'System task execution was cancelled.');
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);

    const onAbort = () => {
      cleanup();
      reject(new systemTasks.SystemTaskExecutionError('cancelled', 'System task execution was cancelled.'));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function parseNoopParams(params: unknown): Readonly<{
  delayMs?: number;
  source?: string;
}> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'Noop params must be an object.');
  }

  const paramRecord = params as Record<string, unknown>;
  const delayMs = paramRecord.delayMs;
  const source = paramRecord.source;
  const allowedKeys = new Set(['delayMs', 'source']);
  for (const key of Object.keys(paramRecord)) {
    if (!allowedKeys.has(key)) {
      throw new systemTasks.SystemTaskExecutionError('invalid_params', `Unknown noop param: ${key}`);
    }
  }

  if (delayMs !== undefined) {
    if (typeof delayMs !== 'number' || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
      throw new systemTasks.SystemTaskExecutionError('invalid_params', 'delayMs must be an integer between 0 and 60000.');
    }
  }

  if (source !== undefined) {
    if (typeof source !== 'string' || source.trim().length === 0) {
      throw new systemTasks.SystemTaskExecutionError('invalid_params', 'source must be a non-empty string.');
    }
  }

  return {
    ...(typeof delayMs === 'number' ? { delayMs } : {}),
    ...(source === undefined ? {} : { source }),
  };
}

function createRelayRuntimeDeps(overrides: HsetupRegistryDeps['relayRuntime']): RelayRuntimeDeps {
  return {
    readStatus: overrides?.readStatus ?? readRelayRuntimeStatusDefault,
    checkHealth: overrides?.checkHealth ?? checkRelayRuntimeHealthDefault,
    installOrUpdate: overrides?.installOrUpdate ?? installOrUpdateRelayRuntimeDefault,
    control: overrides?.control ?? controlRelayRuntimeDefault,
  };
}
