import {
  SystemTaskSpecSchema,
} from '@happier-dev/protocol';

import { type Capability } from '../service';
import { readCliUpdateFactsForThisCli } from '@/cli/runtime/update/cliUpdateFacts';

import { CLI_UPDATE_SYSTEM_TASK_KIND } from '../systemTasks/kinds/cliUpdateRemote';
import { getLiveSystemTasksRunnerAdapter } from '../systemTasks/liveSystemTasksRunner';

export const SYSTEM_TASK_KIND_IDS = [
  'remote.ssh.bootstrapMachine.v1',
  'relay.runtime.installOrUpdate.v1',
  'relay.runtime.start.v1',
  'relay.runtime.status.v1',
  'relay.runtime.stop.v1',
] as const;

/**
 * The kinds this daemon advertises. The list is the capability negotiation: an app offers an
 * action only for a listed kind, so `cli.update.v1` (plan R13 K5) is listed only when this machine
 * can actually run its CLI update remotely (a managed install on a service manager that lets the
 * updater outlive the restart). Older daemons never list it.
 */
export function listAdvertisedSystemTaskKinds(params: Readonly<{ canUpdateCliRemotely: boolean }>): string[] {
  return [...SYSTEM_TASK_KIND_IDS, ...(params.canUpdateCliRemotely ? [CLI_UPDATE_SYSTEM_TASK_KIND] : [])];
}

type SystemTasksRunnerAdapter = Readonly<{
  start: (params: Record<string, unknown>) => Promise<unknown>;
  poll: (params: Record<string, unknown>) => Promise<unknown>;
  respond: (params: Record<string, unknown>) => Promise<void>;
}>;

function createUnsupportedRunner(): SystemTasksRunnerAdapter {
  return {
    start: async () => {
      throw new Error('systemTasks runner is not initialized');
    },
    poll: async () => {
      throw new Error('systemTasks runner is not initialized');
    },
    respond: async () => {
      throw new Error('systemTasks runner is not initialized');
    },
  };
}

export function createProtocolSystemTasksRunnerAdapter(
  runner: Readonly<{
    start: (params: Readonly<{ taskId: string; kind: string; params: unknown }>) => Promise<unknown>;
    poll: (params: Readonly<{ taskId: string; cursor: number }>) => Promise<unknown>;
    respond: (params: Readonly<{ taskId: string; answer: unknown }>) => Promise<void>;
  }>,
  params: Readonly<{
    createTaskId?: () => string;
  }> = {},
): SystemTasksRunnerAdapter {
  const createTaskId = params.createTaskId ?? (() => `system-task:${Date.now()}`);
  return {
    start: async (input) => {
      const parsed = SystemTaskSpecSchema.parse((input as { spec?: unknown }).spec);
      return await runner.start({
        taskId: createTaskId(),
        kind: parsed.kind,
        params: parsed.params,
      });
    },
    poll: async (input) => {
      return await runner.poll({
        taskId: String((input as { taskId?: unknown }).taskId ?? '').trim(),
        cursor: typeof (input as { cursor?: unknown }).cursor === 'number'
          ? (input as { cursor: number }).cursor
          : Number((input as { cursor?: unknown }).cursor ?? 0),
      });
    },
    respond: async (input) => {
      await runner.respond({
        taskId: String((input as { taskId?: unknown }).taskId ?? '').trim(),
        answer: (input as { answer?: unknown }).answer,
      });
    },
  };
}

export function createSystemTasksCapability(
  runner: SystemTasksRunnerAdapter = createUnsupportedRunner(),
  params: Readonly<{ listKinds?: () => string[] }> = {},
): Capability {
  const listKinds = params.listKinds ?? (() => [...SYSTEM_TASK_KIND_IDS]);
  return {
    descriptor: {
      id: 'tool.systemTasks',
      kind: 'tool',
      title: 'System tasks',
      methods: {
        start: { title: 'Start' },
        poll: { title: 'Poll' },
        respond: { title: 'Respond' },
      },
    },
    detect: async () => ({
      available: true,
      kinds: listKinds(),
      methods: ['start', 'poll', 'respond'],
    }),
    invoke: async ({ method, params }) => {
      if (method === 'start') {
        const parsed = SystemTaskSpecSchema.safeParse((params ?? {}).spec);
        if (!parsed.success) {
          return {
            ok: false,
            error: {
              code: 'invalid-system-task-spec',
              message: 'Invalid system task spec',
            },
          };
        }
        return {
          ok: true,
          result: await runner.start(params ?? {}),
        };
      }

      if (method === 'poll') {
        return {
          ok: true,
          result: await runner.poll(params ?? {}),
        };
      }

      if (method === 'respond') {
        await runner.respond(params ?? {});
        return {
          ok: true,
          result: { ok: true },
        };
      }

      return {
        ok: false,
        error: {
          code: 'unsupported-method',
          message: `Unsupported systemTasks method: ${method}`,
        },
      };
    },
  };
}

export const systemTasksCapability: Capability = createSystemTasksCapability(getLiveSystemTasksRunnerAdapter(), {
  listKinds: () => listAdvertisedSystemTaskKinds({ canUpdateCliRemotely: readCliUpdateFactsForThisCli().canUpdateRemotely }),
});
