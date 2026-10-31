import type { AcpConfigOptionOverridesV1, BackendTargetRefV1, ConnectedServiceBindingsV1 } from '@happier-dev/protocol';

import type { ExecutionRunState } from '@/agent/executionRuns/runtime/executionRunTypes';
import {
  ExecutionRunConnectedServicesUnavailableError,
  type PreparedExecutionRunConnectedServices,
} from '@/agent/executionRuns/runtime/prepareExecutionRunConnectedServices';

/**
 * ONE backend rehydration owner for execution-run resume.
 *
 * Start owns a rich launch specification; resume must recreate the backend from the SAME
 * specification instead of reconstructing lossy runtime state. This owner reads the run's immutable
 * launch record and re-derives everything a recreated backend needs — model, canonical config
 * overrides, freshly re-resolved account settings, and a freshly re-materialized connected-service
 * account (via the SAME canonical CS owner used at start, driven by the persisted selection).
 *
 * Fail-closed: when the launch record persisted a connected selection but it cannot be
 * re-materialized (no rehydrator injected, bridge failure, or empty env), this throws a typed error
 * so the resume aborts. A resumable run bound to a connected account must NEVER silently recreate on
 * ambient/native auth.
 */

export type ExecutionRunResumeBackendOptions = Readonly<{
  modelId?: string;
  sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  connectedServicesEnv?: Readonly<Record<string, string>> | null;
  connectedServicesCleanup?: (() => Promise<void>) | null;
  connectedServicesRegistration?: PreparedExecutionRunConnectedServices['registration'];
}>;

export type PrepareExecutionRunConnectedServicesForResume = (params: Readonly<{
  backendTarget: BackendTargetRefV1;
  connectedServices: unknown;
  sessionId: string;
  previousMaterializedRoot?: string;
}>) => Promise<PreparedExecutionRunConnectedServices | null>;

function selectionHasConnectedBinding(selection: ConnectedServiceBindingsV1 | null | undefined): boolean {
  if (!selection) return false;
  return Object.values(selection.bindingsByServiceId).some((binding) => binding.source === 'connected');
}

export async function resolveExecutionRunResumeBackendOptions(args: Readonly<{
  run: ExecutionRunState;
  resolveAccountSettings?: () => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
  prepareConnectedServices?: PrepareExecutionRunConnectedServicesForResume;
}>): Promise<ExecutionRunResumeBackendOptions> {
  const launch = args.run.launch ?? null;
  const agentId = args.run.backendTarget.kind === 'builtInAgent' ? args.run.backendTarget.agentId : args.run.backendId;

  const accountSettings = (await args.resolveAccountSettings?.()) ?? null;

  const options: {
    modelId?: string;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
    accountSettings?: Readonly<Record<string, unknown>> | null;
    connectedServicesEnv?: Readonly<Record<string, string>> | null;
    connectedServicesCleanup?: (() => Promise<void>) | null;
    connectedServicesRegistration?: PreparedExecutionRunConnectedServices['registration'];
  } = {
    accountSettings,
  };

  if (launch?.modelId) options.modelId = launch.modelId;
  if (launch?.sessionConfigOptionOverrides) options.sessionConfigOptionOverrides = launch.sessionConfigOptionOverrides;

  const selection = launch?.connectedServicesSelection ?? null;
  if (selectionHasConnectedBinding(selection)) {
    if (!args.prepareConnectedServices) {
      throw new ExecutionRunConnectedServicesUnavailableError({ agentId });
    }
    const prepared = await args.prepareConnectedServices({
      backendTarget: args.run.backendTarget,
      // The persisted selection is authoritative on resume: pass it as an explicit selection so the
      // CS owner re-materializes the exact same account/profile rather than re-defaulting.
      connectedServices: selection,
      sessionId: args.run.sessionId,
      ...(launch?.connectedServicesRegistration?.materializedRoot
        ? { previousMaterializedRoot: launch.connectedServicesRegistration.materializedRoot }
        : {}),
    });
    if (!prepared) {
      // A connected account was selected at launch but the bridge produced nothing on resume —
      // fail closed rather than recreate on the wrong (inherited) account.
      throw new ExecutionRunConnectedServicesUnavailableError({ agentId });
    }
    options.connectedServicesEnv = prepared.env;
    options.connectedServicesCleanup = prepared.cleanup;
    options.connectedServicesRegistration = prepared.registration;
  }

  return options;
}
