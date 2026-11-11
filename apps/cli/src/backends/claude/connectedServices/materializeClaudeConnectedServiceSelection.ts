import { join, resolve } from 'node:path';

import type {
  AccountSettings,
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';

import type { ConnectedServicesMaterializationDiagnostic } from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import type { ConnectedServicesProviderMaterializerInput } from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import type { ConnectedServiceResolvedSelection } from '@/daemon/connectedServices/materialize/materializeConnectedServicesForSpawn';

import { resolveClaudeConfigDirOverride } from '@/backends/claude/utils/resolveClaudeConfigDirOverride';
import { resolveConfiguredClaudeConfigDir } from '@/backends/claude/utils/resolveConfiguredClaudeConfigDir';
import { findClaudeConfigurationSourceScopeViolation, isPathWithinDirectory } from './claudeConfigurationSourceScope';
import { materializeClaudeAnthropicApiKeyAuth } from './materializeClaudeAnthropicApiKeyAuth';
import {
  materializeClaudeSubscriptionNativeAuthHome,
  type ClaudeSubscriptionNativeAuthIdentityDiagnostic,
  type ClaudeSubscriptionNativeAuthSelectionDescriptor,
} from './nativeAuth/materializeClaudeCodeNativeAuth';
import { resolveClaudeConnectedServiceStableConfigDir } from './resolveClaudeConnectedServiceStableAuthDir';
import { syncClaudeConnectedServiceHome } from './syncClaudeConnectedServiceHome';

export type ClaudeConnectedServiceMaterializationServiceId = Extract<
  ConnectedServiceId,
  'claude-subscription' | 'anthropic'
>;

export type ClaudeConnectedServiceSelectionMaterialization = Readonly<{
  env: Record<string, string>;
  targetMaterializedRoot: string;
  diagnostics: readonly ConnectedServicesMaterializationDiagnostic[];
  identityDiagnostic?: ClaudeSubscriptionNativeAuthIdentityDiagnostic;
}>;

function withoutClaudeConfigDirOverrides(processEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const nextEnv = { ...processEnv };
  delete nextEnv.CLAUDE_CONFIG_DIR;
  delete nextEnv.HAPPIER_CLAUDE_CONFIG_DIR;
  return nextEnv;
}

function isWithinDir(path: string, root: string): boolean {
  return isPathWithinDirectory(resolve(path), resolve(root));
}

function resolveConnectedServiceManagedHomesRoot(activeServerDir: string): string {
  return join(activeServerDir, 'daemon', 'connected-services', 'homes');
}

function isClaudeManagedConnectedServiceConfigDir(params: Readonly<{
  activeServerDir: string;
  claudeConfigDir: string;
}>): boolean {
  return isWithinDir(
    params.claudeConfigDir,
    join(resolveConnectedServiceManagedHomesRoot(params.activeServerDir), 'claude-subscription'),
  );
}

/** The refusal returned, with nothing read from the source, when its entries resolve out of scope. */
function sourceScopeRefusal(params: Readonly<{
  claudeConfigDir: string;
  diagnostic: ConnectedServicesMaterializationDiagnostic;
}>): ClaudeConnectedServiceSelectionMaterialization {
  return {
    env: { CLAUDE_CONFIG_DIR: params.claudeConfigDir },
    targetMaterializedRoot: params.claudeConfigDir,
    diagnostics: [params.diagnostic],
  };
}

/**
 * The environment naming the one permitted Claude configuration source for a managed home.
 *
 * Credential provenance governs auth preservation, not configuration freshness: reconcile from the
 * configured native home, never from a materialized copy of it. A configured dir that is the target
 * or another managed home is not a permitted source, and the ambient HOME is never substituted for
 * it. `HAPPIER_CLAUDE_CONFIG_DIR` can still name the permitted source when an inherited
 * `CLAUDE_CONFIG_DIR` (a daemon started inside a managed session) shadows it. Otherwise the target
 * is its own source: nothing is imported or projected into it, and its existing state is kept.
 */
function resolveClaudeConfigurationSourceEnv(params: Readonly<{
  activeServerDir: string;
  processEnv: NodeJS.ProcessEnv;
  targetClaudeConfigDir: string;
}>): NodeJS.ProcessEnv {
  const isPermittedSource = (claudeConfigDir: string): boolean =>
    resolve(claudeConfigDir) !== resolve(params.targetClaudeConfigDir)
    && !isClaudeManagedConnectedServiceConfigDir({ activeServerDir: params.activeServerDir, claudeConfigDir });

  if (isPermittedSource(resolveConfiguredClaudeConfigDir({ env: params.processEnv }))) {
    return params.processEnv;
  }
  const happierOverrideEnv = { ...params.processEnv };
  delete happierOverrideEnv.CLAUDE_CONFIG_DIR;
  const happierOverride = resolveClaudeConfigDirOverride(happierOverrideEnv);
  if (happierOverride && isPermittedSource(happierOverride)) {
    return happierOverrideEnv;
  }
  return {
    ...withoutClaudeConfigDirOverrides(params.processEnv),
    CLAUDE_CONFIG_DIR: params.targetClaudeConfigDir,
  };
}

export function buildClaudeSubscriptionNativeAuthSelectionDescriptor(params: Readonly<{
  fallbackProfileId: string;
  selection: ConnectedServiceResolvedSelection | null | undefined;
}>): ClaudeSubscriptionNativeAuthSelectionDescriptor {
  if (params.selection?.kind === 'group') {
    return {
      kind: 'group',
      serviceId: 'claude-subscription',
      groupId: params.selection.groupId,
      activeProfileId: params.selection.activeProfileId,
      fallbackProfileId: params.selection.fallbackProfileId,
      generation: params.selection.generation,
      credentialRevision: params.selection.credentialRevision ?? null,
    };
  }
  return {
    kind: 'profile',
    serviceId: 'claude-subscription',
    profileId: params.selection?.kind === 'profile' ? params.selection.profileId : params.fallbackProfileId,
  };
}

function hasBlockingDiagnostics(diagnostics: readonly ConnectedServicesMaterializationDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'blocking');
}

function dedupeDiagnostics<T extends Readonly<{
  code: string;
  serviceId?: string;
  reason?: string;
  entryName?: string;
}>>(diagnostics: readonly T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.code,
      diagnostic.serviceId ?? '',
      diagnostic.reason ?? '',
      diagnostic.entryName ?? '',
    ].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(diagnostic);
  }
  return deduped;
}

export async function materializeClaudeConnectedServiceSelection(params: Readonly<{
  activeServerDir: string;
  probeConfigDir?: string;
  serviceId: ClaudeConnectedServiceMaterializationServiceId;
  record: ConnectedServiceCredentialRecordV1;
  fallbackProfileId: string;
  selection?: ConnectedServiceResolvedSelection | null | undefined;
  processEnv: NodeJS.ProcessEnv;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  sessionDirectory?: string | null;
  vendorResumeId?: string | null;
  candidatePersistedSessionFile?: string | null;
  sessionStateMode?: 'existing';
  validateGroupMutationCurrentness?: ConnectedServicesProviderMaterializerInput['validateGroupMutationCurrentness'];
}>): Promise<ClaudeConnectedServiceSelectionMaterialization | null> {
  const claudeConfigDir = params.probeConfigDir ?? resolveClaudeConnectedServiceStableConfigDir({
    activeServerDir: params.activeServerDir,
    serviceId: params.serviceId,
    fallbackProfileId: params.fallbackProfileId,
    selection: params.selection ?? null,
  });
  if (!claudeConfigDir) return null;

  if (params.serviceId === 'claude-subscription') {
    const selectionDescriptor = buildClaudeSubscriptionNativeAuthSelectionDescriptor({
      fallbackProfileId: params.fallbackProfileId,
      selection: params.selection ?? null,
    });
    let groupSource: Readonly<{ env: NodeJS.ProcessEnv; originSourceEnv: NodeJS.ProcessEnv }> | null = null;
    let groupSourceDiagnostics: readonly ConnectedServicesMaterializationDiagnostic[] = [];
    if (selectionDescriptor.kind === 'group' && !params.probeConfigDir) {
      const profileClaudeConfigDir = resolveClaudeConnectedServiceStableConfigDir({
        activeServerDir: params.activeServerDir,
        serviceId: params.serviceId,
        fallbackProfileId: selectionDescriptor.activeProfileId,
        selection: {
          kind: 'profile',
          serviceId: 'claude-subscription',
          profileId: selectionDescriptor.activeProfileId,
          record: params.record,
        },
      });
      if (profileClaudeConfigDir) {
        const canonicalProfileSelectionDescriptor = {
          kind: 'profile' as const,
          serviceId: 'claude-subscription' as const,
          profileId: selectionDescriptor.activeProfileId,
        };
        const profileSourceEnv = resolveClaudeConfigurationSourceEnv({
          activeServerDir: params.activeServerDir,
          processEnv: params.processEnv,
          targetClaudeConfigDir: profileClaudeConfigDir,
        });
        const profileSourceViolation = await findClaudeConfigurationSourceScopeViolation({
          sourceEnv: profileSourceEnv,
          targetDir: profileClaudeConfigDir,
          managedHomesRoot: resolveConnectedServiceManagedHomesRoot(params.activeServerDir),
          permittedManagedHome: null,
          serviceId: params.serviceId,
        });
        if (profileSourceViolation) {
          return sourceScopeRefusal({ claudeConfigDir, diagnostic: profileSourceViolation });
        }
        const canonicalProfileMaterialized = await materializeClaudeSubscriptionNativeAuthHome({
          record: params.record,
          targetClaudeConfigDir: profileClaudeConfigDir,
          sourceEnv: profileSourceEnv,
          accountSettings: params.accountSettings ?? null,
          sessionDirectory: params.sessionDirectory ?? null,
          vendorResumeId: params.vendorResumeId ?? null,
          candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
          sessionStateMode: params.sessionStateMode,
          selectionDescriptor: canonicalProfileSelectionDescriptor,
          validateGroupMutationCurrentness: params.validateGroupMutationCurrentness,
        });
        groupSourceDiagnostics = canonicalProfileMaterialized.diagnostics;
        if (
          canonicalProfileMaterialized.status === 'diagnostic'
          || hasBlockingDiagnostics(canonicalProfileMaterialized.diagnostics)
        ) {
          return {
            env: { CLAUDE_CONFIG_DIR: claudeConfigDir },
            targetMaterializedRoot: claudeConfigDir,
            diagnostics: canonicalProfileMaterialized.diagnostics,
            identityDiagnostic: canonicalProfileMaterialized.identityDiagnostic,
          };
        }
        groupSource = {
          env: { ...params.processEnv, ...canonicalProfileMaterialized.env },
          originSourceEnv: profileSourceEnv,
        };
      }
    }
    const sourceEnv = groupSource?.env ?? resolveClaudeConfigurationSourceEnv({
      activeServerDir: params.activeServerDir,
      processEnv: params.processEnv,
      targetClaudeConfigDir: claudeConfigDir,
    });
    const sourceViolation = await findClaudeConfigurationSourceScopeViolation({
      sourceEnv,
      targetDir: claudeConfigDir,
      managedHomesRoot: resolveConnectedServiceManagedHomesRoot(params.activeServerDir),
      // A group's canonical member home is a deliberate managed source; no other managed home is.
      // The native source it was materialized from keeps its permission for the links it retains.
      permittedManagedHome: groupSource ? resolveConfiguredClaudeConfigDir({ env: groupSource.env }) : null,
      permittedOriginSourceEnv: groupSource?.originSourceEnv ?? null,
      serviceId: params.serviceId,
    });
    if (sourceViolation) {
      return sourceScopeRefusal({ claudeConfigDir, diagnostic: sourceViolation });
    }
    const materialized = await materializeClaudeSubscriptionNativeAuthHome({
      record: params.record,
      targetClaudeConfigDir: claudeConfigDir,
      sourceEnv,
      accountSettings: params.accountSettings ?? null,
      sessionDirectory: params.sessionDirectory ?? null,
      vendorResumeId: params.vendorResumeId ?? null,
      candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
      sessionStateMode: params.sessionStateMode,
      selectionDescriptor,
      validateGroupMutationCurrentness: params.validateGroupMutationCurrentness,
    });
    return {
      env: materialized.env,
      targetMaterializedRoot: claudeConfigDir,
      diagnostics: dedupeDiagnostics([...groupSourceDiagnostics, ...materialized.diagnostics]),
      identityDiagnostic: materialized.identityDiagnostic,
    };
  }

  if (params.sessionStateMode !== 'existing') {
    const managedHomesRoot = resolveConnectedServiceManagedHomesRoot(params.activeServerDir);
    const sourceViolation = await findClaudeConfigurationSourceScopeViolation({
      sourceEnv: params.processEnv,
      targetDir: claudeConfigDir,
      managedHomesRoot,
      // This path has always imported from the configured dir as given, including a managed home it
      // names directly; only entries that resolve elsewhere than they appear are refused here.
      permittedManagedHome: isWithinDir(resolveConfiguredClaudeConfigDir({ env: params.processEnv }), managedHomesRoot)
        ? resolveConfiguredClaudeConfigDir({ env: params.processEnv })
        : null,
      serviceId: params.serviceId,
    });
    if (sourceViolation) {
      return sourceScopeRefusal({ claudeConfigDir, diagnostic: sourceViolation });
    }
  }
  const diagnostics = params.sessionStateMode === 'existing' ? [] : (await syncClaudeConnectedServiceHome({
    sourceEnv: params.processEnv,
    targetDir: claudeConfigDir,
    accountSettings: params.accountSettings ?? null,
    sessionDirectory: params.sessionDirectory ?? null,
  })).diagnostics;
  const materialized = materializeClaudeAnthropicApiKeyAuth({ record: params.record });
  return {
    env: {
      ...materialized.env,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
    },
    targetMaterializedRoot: claudeConfigDir,
    diagnostics,
  };
}
