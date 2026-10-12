import { randomUUID } from 'node:crypto';

import type { AgentId } from '@happier-dev/agents';
import type { BackendTargetRefV1, ConnectedServiceBindingsV1, ConnectedServiceBindingSelectionV1, ConnectedServiceId } from '@happier-dev/protocol';
import { ConnectedServiceBindingsV1Schema } from '@happier-dev/protocol';

import {
  materializeDaemonConnectedServicesForExecutionRun,
  releaseDaemonConnectedServicesForExecutionRun,
} from '@/daemon/controlClient';
import {
  ExecutionRunConnectedServiceMaterializationProofV1Schema,
  ExecutionRunConnectedServiceMaterializedEnvSchema,
} from '@/daemon/connectedServices/runsBridge/contract';
import type { ExecutionRunConnectedServiceMaterializationProofV1 } from '@/daemon/connectedServices/runsBridge/contract';
import { ExecutionRunConnectedServiceRegistrationV1Schema } from '@/daemon/connectedServices/runsBridge/contract';
import type { ExecutionRunConnectedServiceRegistrationV1 } from '@/daemon/connectedServices/runsBridge/contract';
import type { Credentials } from '@/persistence';
import { resolveSessionAgentSpawnConnectedServicesDefaults } from '@/session/services/spawn/normalizeSessionAgentSpawnActionRequest';
import { resolveSpawnConnectedServicesDefaults } from '@/session/services/spawnConnectedServicesDefaults';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { logger } from '@/ui/logger';
import {
  readConnectedServiceChildSelectionsFromEnv,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';

/**
 * Runner-side owner of the ER-CS start flow: resolve the run's effective connected-services selection
 * and, when one exists, ask the DAEMON bridge to materialize it for a run-scoped key. Returns the env
 * to merge into the run's isolation bundle plus an idempotent `cleanup` that releases the daemon-side
 * registration + root at run end.
 *
 * Selection resolution (QA2-F02 root cause): an explicit per-target selection wins; otherwise the run
 * defaults through `resolveSessionAgentSpawnConnectedServicesDefaults` — the SAME owner sessions use
 * at spawn (fresh blocking settings bootstrap). The runner's in-process settings snapshot is NOT
 * consulted: it is a second, potentially stale settings surface whose empty/partial state silently
 * killed defaulting on a live run (G5 failure). One defaulting owner, one settings path.
 *
 * Observability (QA2-F03): every run start emits exactly one info-level decision line — materialized
 * (env key NAMES + key/source), proceeding native, or failing closed. Never token/secret values.
 *
 * Fail-closed: when a selection EXISTS but the bridge cannot deliver it, this throws a typed error —
 * the run must never silently start on the runner's inherited (wrong) account. When no selection
 * exists at all, it returns null and the run keeps default behavior (logged).
 */

export class ExecutionRunConnectedServicesUnavailableError extends Error {
  readonly code = 'execution_run_connected_services_unavailable' as const;
  readonly agentId: string;
  readonly cause?: unknown;

  constructor(params: Readonly<{ agentId: string; cause?: unknown }>) {
    super(`Connected services are selected for this run but could not be materialized (${params.agentId})`);
    this.name = 'ExecutionRunConnectedServicesUnavailableError';
    this.agentId = params.agentId;
    this.cause = params.cause;
  }
}

export type PreparedExecutionRunConnectedServices = Readonly<{
  env: Readonly<Record<string, string>>;
  materializationKey: string;
  cleanup: () => Promise<void>;
  /**
   * The canonical connected-service selection that was actually materialized for this run. Persisted
   * verbatim in the run's immutable launch record so a later resume can re-materialize the SAME
   * account/profile (as an explicit, authoritative selection) instead of re-resolving a drifting
   * session default. Contains only binding metadata — never tokens or materialized env values.
   */
  selection: ConnectedServiceBindingsV1;
  /** Exact non-secret daemon registration fact used only for passive replacement re-registration. */
  registration: ExecutionRunConnectedServiceRegistrationV1;
}>;

type MaterializeViaDaemon = typeof materializeDaemonConnectedServicesForExecutionRun;
type ReleaseViaDaemon = (
  body: Readonly<{ runId: string; pid: number; materializationKey: string }>,
) => Promise<boolean>;
type ResolveSessionSpawnDefaults = (params: Readonly<{
  backendTarget: BackendTargetRefV1 & { kind: 'builtInAgent' };
  credentials: Credentials;
}>) => Promise<Readonly<{ connectedServices: ConnectedServiceBindingsV1 }> | null>;

/**
 * Resolves a bare per-service default token (`"<serviceId>"`) to that service's STORED default binding
 * only (never broadening to the whole agent). Missing stored default → the service is omitted from the
 * returned bindings, which the caller treats as fail-closed. Reuses the canonical
 * `resolveSpawnConnectedServicesDefaults` owner with a `serviceIds` filter.
 */
export type ResolvePerServiceConnectedServicesDefaults = (params: Readonly<{
  backendTarget: BackendTargetRefV1 & { kind: 'builtInAgent' };
  credentials: Credentials;
  serviceIds: readonly ConnectedServiceId[];
}>) => Promise<ConnectedServiceBindingsV1 | null>;

const defaultResolvePerServiceConnectedServicesDefaults: ResolvePerServiceConnectedServicesDefaults =
  async ({ backendTarget, credentials, serviceIds }) => {
    try {
      const accountSettingsContext = await bootstrapAccountSettingsContext({
        credentials,
        mode: 'blocking',
        deps: { applySideEffects: () => undefined },
      });
      return resolveSpawnConnectedServicesDefaults({
        accountSettings: accountSettingsContext.settings,
        agentId: backendTarget.agentId as AgentId,
        serviceIds,
      });
    } catch {
      return null;
    }
  };

type ResolvedRunSelection = Readonly<{
  bindings: ConnectedServiceBindingsV1;
  source: 'explicit' | 'session_default';
}> | null;

function hasConnectedBinding(bindings: ConnectedServiceBindingsV1): boolean {
  return Object.values(bindings.bindingsByServiceId).some((binding) => binding.source === 'connected');
}

function proofMatchesSelectedConnectedIdentity(params: Readonly<{
  proof: unknown;
  agentId: string;
  materializationKey: string;
  selection: ConnectedServiceBindingsV1;
}>): boolean {
  const parsed = ExecutionRunConnectedServiceMaterializationProofV1Schema.safeParse(params.proof);
  if (
    !parsed.success
    || parsed.data.agentId !== params.agentId
    || parsed.data.materializationKey !== params.materializationKey
  ) return false;

  const selectedConnectedEntries = Object.entries(params.selection.bindingsByServiceId)
    .filter((entry): entry is [string, Extract<ConnectedServiceBindingSelectionV1, { source: 'connected' }>] =>
      entry[1].source === 'connected');
  const provenConnectedEntries = Object.entries(parsed.data.connectedServicesBindings.bindingsByServiceId)
    .filter((entry): entry is [string, Extract<ConnectedServiceBindingSelectionV1, { source: 'connected' }>] =>
      entry[1].source === 'connected');

  if (selectedConnectedEntries.length === 0 || selectedConnectedEntries.length !== provenConnectedEntries.length) {
    return false;
  }

  return selectedConnectedEntries.every(([serviceId, selected]) => {
    const proven = parsed.data.connectedServicesBindings.bindingsByServiceId[serviceId];
    if (!proven || proven.source !== 'connected') return false;
    if (selected.selection === 'group') {
      return proven.selection === 'group' && proven.groupId === selected.groupId;
    }
    return proven.selection !== 'group' && proven.profileId === selected.profileId;
  });
}

async function resolveRunSelection(params: Readonly<{
  backendTarget: BackendTargetRefV1 & { kind: 'builtInAgent' };
  explicitBindings: unknown;
  defaultServiceIds: readonly ConnectedServiceId[];
  credentials: Credentials | null;
  resolveSessionSpawnDefaults: ResolveSessionSpawnDefaults;
  resolvePerServiceDefaults: ResolvePerServiceConnectedServicesDefaults;
}>): Promise<ResolvedRunSelection> {
  const agentId = params.backendTarget.agentId;

  // Canonical null is an explicit whole-run native-auth selection. Decide it before the absent
  // selection/account-default path so an explicit opt-out can never inherit account defaults.
  if (params.explicitBindings === null) return null;

  // Parse explicit per-service pins first (authoritative; explicit always wins over a bare default).
  let explicitBindingsByServiceId: Record<string, ConnectedServiceBindingSelectionV1> = {};
  let hadValidExplicit = false;
  if (params.explicitBindings !== undefined) {
    const parsed = ConnectedServiceBindingsV1Schema.safeParse(params.explicitBindings);
    if (parsed.success) {
      explicitBindingsByServiceId = { ...parsed.data.bindingsByServiceId };
      hadValidExplicit = true;
    } else {
      // Malformed explicit selection: never guess an account from garbage — fall through to the
      // account default (which itself fails closed to null when unset).
      logger.warn('[EXECUTION RUN] connected services: malformed explicit selection ignored; falling back to account default', {
        agentId,
      });
    }
  }

  // RO-F5 seam: resolve each bare per-service DEFAULT token to that service's stored default and merge
  // it UNDER the explicit pins (explicit wins; grammar rejects same-service duplicates pre-resolution).
  // A named default with no stored connected default fails CLOSED — never silently native/ambient.
  const defaultServiceIdsToResolve = params.defaultServiceIds.filter(
    (serviceId) => !Object.prototype.hasOwnProperty.call(explicitBindingsByServiceId, serviceId),
  );
  if (defaultServiceIdsToResolve.length > 0) {
    if (!params.credentials) {
      throw new ExecutionRunConnectedServicesUnavailableError({ agentId });
    }
    const resolvedDefaults = await params.resolvePerServiceDefaults({
      backendTarget: params.backendTarget,
      credentials: params.credentials,
      serviceIds: defaultServiceIdsToResolve,
    });
    const merged: Record<string, ConnectedServiceBindingSelectionV1> = { ...explicitBindingsByServiceId };
    for (const serviceId of defaultServiceIdsToResolve) {
      const binding = resolvedDefaults?.bindingsByServiceId[serviceId];
      if (!binding || binding.source !== 'connected') {
        // Missing stored default for a service the caller explicitly asked to default → fail closed.
        throw new ExecutionRunConnectedServicesUnavailableError({ agentId });
      }
      merged[serviceId] = binding;
    }
    const bindings = ConnectedServiceBindingsV1Schema.parse({ v: 1, bindingsByServiceId: merged });
    return { bindings, source: hadValidExplicit ? 'explicit' : 'session_default' };
  }

  if (hadValidExplicit) {
    const bindings = ConnectedServiceBindingsV1Schema.parse({ v: 1, bindingsByServiceId: explicitBindingsByServiceId });
    // A valid explicit selection is authoritative — including "all native" (the caller opted out).
    return hasConnectedBinding(bindings) ? { bindings, source: 'explicit' } : null;
  }

  if (!params.credentials) return null;
  const resolved = await params.resolveSessionSpawnDefaults({
    backendTarget: params.backendTarget,
    credentials: params.credentials,
  });
  if (!resolved) return null;
  return { bindings: resolved.connectedServices, source: 'session_default' };
}

export async function prepareExecutionRunConnectedServices(params: Readonly<{
  backendTarget: BackendTargetRefV1;
  /** Optional explicit per-target selection from the run-start request. */
  connectedServices?: unknown;
  /**
   * Optional bare per-service default tokens from the run-start request (RO-F5): services asking for
   * their STORED default. Resolved here to concrete bindings and merged UNDER any explicit pins;
   * missing stored default fails closed. On resume this stays empty — the persisted selection already
   * carries the resolved concrete bindings.
   */
  connectedServicesDefaultServiceIds?: readonly string[];
  /** Runner credentials — required for account-default resolution (the session owner bootstraps settings). */
  credentials: Credentials | null;
  cwd: string;
  sessionId: string;
  /** Boundary injection points; default to the canonical control client + session defaulting owner. */
  materializeViaDaemon?: MaterializeViaDaemon;
  releaseViaDaemon?: ReleaseViaDaemon;
  resolveSessionSpawnDefaults?: ResolveSessionSpawnDefaults;
  resolvePerServiceDefaults?: ResolvePerServiceConnectedServicesDefaults;
}>): Promise<PreparedExecutionRunConnectedServices | null> {
  if (params.backendTarget.kind !== 'builtInAgent') return null;
  const backendTarget = params.backendTarget;
  const agentId = backendTarget.agentId;

  const selection = await resolveRunSelection({
    backendTarget,
    explicitBindings: params.connectedServices,
    defaultServiceIds: (params.connectedServicesDefaultServiceIds ?? []) as readonly ConnectedServiceId[],
    credentials: params.credentials,
    resolveSessionSpawnDefaults: params.resolveSessionSpawnDefaults
      ?? resolveSessionAgentSpawnConnectedServicesDefaults,
    resolvePerServiceDefaults: params.resolvePerServiceDefaults
      ?? defaultResolvePerServiceConnectedServicesDefaults,
  });
  if (!selection) {
    // QA2-F03: the one decision line for the native path — a run silently starting on the
    // runner-inherited account must always be diagnosable from the log.
    logger.info('[EXECUTION RUN] connected services: no selection resolved; proceeding native', {
      agentId,
      hadExplicitSelection: params.connectedServices !== undefined && params.connectedServices !== null,
      hadCredentials: params.credentials !== null,
    });
    return null;
  }

  const materialize = params.materializeViaDaemon ?? materializeDaemonConnectedServicesForExecutionRun;
  const release = params.releaseViaDaemon
    ?? (async (body: Readonly<{ runId: string; pid: number; materializationKey: string }>) =>
      await releaseDaemonConnectedServicesForExecutionRun(body));

  // Run-scoped materialization key. The manager allocates the public runId later; the key only needs
  // to be run-unique and stable between materialize and release, so it carries its own id.
  const materializationKey = `execution_run:${randomUUID()}`;

  let cleanupPromise: Promise<void> | null = null;
  const cleanup = (): Promise<void> => {
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        try {
          await release({ runId: materializationKey, pid: process.pid, materializationKey });
        } catch (error) {
          // Best-effort: a failed release must not fail run teardown.
          logger.debug('[EXECUTION RUN] Connected-services release failed (non-fatal)', error);
        }
      })();
    }
    return cleanupPromise;
  };

  let materialized: Awaited<ReturnType<MaterializeViaDaemon>>;
  try {
    materialized = await materialize({
      runId: materializationKey,
      agentId,
      pid: process.pid,
      materializationKey,
      connectedServicesBindingsRaw: selection.bindings,
      sessionDirectory: params.cwd,
      sessionId: params.sessionId,
    });
  } catch (error) {
    logger.warn('[EXECUTION RUN] connected services: materialization FAILED; failing run start closed', {
      agentId,
      source: selection.source,
      materializationKey,
      error: error instanceof Error ? error.message : String(error),
    });
    // A1: the daemon may have SUCCEEDED after the client abandoned the call (transport timeout) —
    // fire the idempotent release for the run key so a late daemon-side root + registered target are
    // always reclaimed. Best-effort by construction (cleanup swallows its own failures).
    await cleanup();
    throw new ExecutionRunConnectedServicesUnavailableError({ agentId, cause: error });
  }

  // Keep a runner-side defense even though the control client parses the wire schema: injected test
  // boundaries and mixed-version callers must not turn an empty path into ambient provider auth.
  const parsedEnv = ExecutionRunConnectedServiceMaterializedEnvSchema.safeParse(materialized.env);
  const envKeys = parsedEnv.success ? Object.keys(parsedEnv.data) : [];
  const parsedProof = ExecutionRunConnectedServiceMaterializationProofV1Schema.safeParse(materialized.proof);
  const hasValidProof = proofMatchesSelectedConnectedIdentity({
    proof: materialized.proof,
    agentId,
    materializationKey,
    selection: selection.bindings,
  });
  const parsedRegistration = ExecutionRunConnectedServiceRegistrationV1Schema.safeParse(materialized.registration);
  const hasValidRegistration = parsedRegistration.success && proofMatchesSelectedConnectedIdentity({
    proof: {
      v: parsedRegistration.data.v,
      agentId: parsedRegistration.data.agentId,
      materializationKey: parsedRegistration.data.materializationKey,
      connectedServicesBindings: parsedRegistration.data.connectedServicesBindings,
    },
    agentId,
    materializationKey,
    selection: selection.bindings,
  }) && parsedProof.success
    && JSON.stringify(parsedRegistration.data.connectedServicesBindings)
      === JSON.stringify(parsedProof.data.connectedServicesBindings);
  if (!parsedEnv.success || !hasValidProof || !hasValidRegistration) {
    // Transport success is not connected-auth success. Under the current run bridge, a non-empty
    // provider-owned environment is the minimum materialization proof; accepting an empty result
    // would execute under ambient credentials after the user selected a connected identity.
    await cleanup();
    logger.warn('[EXECUTION RUN] connected services: bridge returned no materialization proof; failing run start closed', {
      agentId,
      source: selection.source,
      materializationKey,
      envKeyCount: envKeys.length,
      proofValid: hasValidProof,
      registrationValid: hasValidRegistration,
    });
    throw new ExecutionRunConnectedServicesUnavailableError({ agentId });
  }

  // QA2-F03: the one decision line for the materialized path. Env key NAMES only — values are paths
  // into the materialized root and stay out of logs anyway; tokens never appear in env at all.
  logger.info('[EXECUTION RUN] connected services: materialized', {
    agentId,
    source: selection.source,
    materializationKey,
    envKeys,
  });

  return {
    env: parsedEnv.data,
    materializationKey,
    cleanup,
    selection: selection.bindings,
    registration: (() => {
      const connectedServiceSelections = readConnectedServiceChildSelectionsFromEnv(parsedEnv.data);
      const connectedServiceSelectionsJson = connectedServiceSelections.length > 0
        ? JSON.stringify(connectedServiceSelections)
        : null;
      return { ...parsedRegistration.data, connectedServiceSelectionsJson };
    })(),
  };
}
