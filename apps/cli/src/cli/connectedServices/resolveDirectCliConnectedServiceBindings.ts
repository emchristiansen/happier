import { AGENTS_CORE, type AgentId } from '@happier-dev/agents';
import type { AccountSettings, ConnectedServiceBindingsV1 } from '@happier-dev/protocol';

import { resolveCliConnectedServicesLaunchBindings } from '@/cli/connectedServicesLaunchAuth';
import { normalizeActionExecuteResult } from '@/cli/commands/session/shared/normalizeActionExecuteResult';
import type { Credentials } from '@/persistence';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { resolveSpawnConnectedServicesDefaultDisposition } from '@/session/services/spawnConnectedServicesDefaults';

/**
 * The account's spawn-selectable connected-service inventory for an agent: the one inventory every
 * direct CLI selection is checked against before materialization.
 */
export async function listDirectCliConnectedServicesInventory(params: Readonly<{
  agentId: AgentId;
  credentials: Credentials;
}>): Promise<unknown> {
  const executor = createCliActionExecutorFromCredentials({ credentials: params.credentials });
  const result = normalizeActionExecuteResult(await executor.execute(
    'sessions.spawn.connected_services.list',
    { agentId: params.agentId, includeUnavailable: false },
    { surface: 'cli', defaultSessionId: null },
  ));
  if (!result.ok) throw new Error(result.errorMessage ?? result.errorCode);
  return result.data ?? null;
}

/**
 * The Remote direct-CLI selection adapter. Direct agent commands share this
 * settings/default/inventory path and hand only canonical bindings to the
 * existing materialization owner.
 */
export async function resolveDirectCliConnectedServiceBindings(params: Readonly<{
  agentId: AgentId;
  credentials: Credentials;
  accountSettings: AccountSettings;
  authRaw: string | undefined;
  authJsonRaw: string | undefined;
}>): Promise<ConnectedServiceBindingsV1 | null> {
  const supportedServiceIds =
    AGENTS_CORE[params.agentId].connectedServices?.supportedServiceIds ?? [];
  if (
    supportedServiceIds.length === 0
    && params.authRaw === undefined
    && params.authJsonRaw === undefined
  ) {
    return null;
  }

  return await resolveCliConnectedServicesLaunchBindings({
    authRaw: params.authRaw,
    authJsonRaw: params.authJsonRaw,
    supportedServiceIds,
    defaultDisposition: resolveSpawnConnectedServicesDefaultDisposition({
      accountSettings: params.accountSettings,
      agentId: params.agentId,
    }),
    listInventory: async () => await listDirectCliConnectedServicesInventory({
      agentId: params.agentId,
      credentials: params.credentials,
    }),
  });
}
