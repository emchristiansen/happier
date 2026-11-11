import { join, resolve } from 'node:path';

import type {
  AccountSettings,
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';

import {
  ConnectedServiceNativeSourceProvenanceError,
  type ConnectedServiceNativeSourceAuthority,
  type ConnectedServicesMaterializationDiagnostic,
  type ConnectedServicesProviderMaterializerInput,
} from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import type { ConnectedServiceResolvedSelection } from '@/daemon/connectedServices/materialize/materializeConnectedServicesForSpawn';

import { resolveClaudeConfigDirOverride } from '@/backends/claude/utils/resolveClaudeConfigDirOverride';
import { resolveConfiguredClaudeConfigDir } from '@/backends/claude/utils/resolveConfiguredClaudeConfigDir';
import { findClaudeConfigurationSourceScopeViolation, isPathWithinDirectory } from './claudeConfigurationSourceScope';
import {
  admitClaudeNativeSource,
  assertClaudeHomeSourceAgrees,
  claudeNativeSourceEnv,
  claudeNativeSourceFromEnv,
  isClaudeSelfSource,
  readClaudeHomeProvenance,
  type ClaudeAdmittedNativeSource,
} from './claudeHomeNativeSource';
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
 * The native source a group home takes through its member home: the member's admitted source or, for
 * a member that is its own source, the origin the member records (else the member home itself). A
 * member's recorded origin is never dropped when the member becomes another home's content.
 */
async function resolveClaudeMemberOrigin(
  memberSource: ClaudeAdmittedNativeSource | undefined,
  memberClaudeConfigDir: string,
): Promise<ClaudeAdmittedNativeSource | undefined> {
  if (!memberSource || !isClaudeSelfSource(memberSource, memberClaudeConfigDir)) return memberSource;
  const provenance = await readClaudeHomeProvenance(memberClaudeConfigDir);
  return provenance.kind === 'recorded' && !isClaudeSelfSource(provenance.source, memberClaudeConfigDir)
    ? provenance.source
    : memberSource;
}

type AdmittedClaudeSource = Readonly<{
  /** The environment the materialization reads its source through. */
  env: NodeJS.ProcessEnv;
  /** The admitted native source, recorded by the sync; absent when nothing is read. */
  nativeSource?: ClaudeAdmittedNativeSource;
  /**
   * `existing` when only credentials may be published: a requested credential-only handoff, or a
   * rematerialization of a home whose source was never recorded (nothing is read, linked or recorded).
   */
  sessionStateMode?: 'existing';
  /** Whether the source scope check applies (it is skipped only when admission reads nothing). */
  checksSourceScope: boolean;
}>;

/**
 * Admits the source a home is materialized from (`admitClaudeNativeSource`) before any scope check,
 * lock or read. `requestedEnv` is the caller's own source, used only under `caller_env`. A requested
 * credential-only handoff (`existing`) keeps its existing behavior and admits nothing.
 */
async function admitClaudeSource(params: Readonly<{
  nativeSourceAuthority: ConnectedServiceNativeSourceAuthority;
  claudeConfigDir: string;
  previousClaudeConfigDir: string | null;
  requestedEnv: NodeJS.ProcessEnv;
  processEnv: NodeJS.ProcessEnv;
  sessionStateMode?: 'existing';
}>): Promise<AdmittedClaudeSource> {
  if (params.sessionStateMode === 'existing') {
    return { env: params.requestedEnv, sessionStateMode: 'existing', checksSourceScope: true };
  }
  const admission = await admitClaudeNativeSource({
    nativeSourceAuthority: params.nativeSourceAuthority,
    claudeConfigDir: params.claudeConfigDir,
    previousClaudeConfigDir: params.previousClaudeConfigDir,
    requested: claudeNativeSourceFromEnv(params.requestedEnv),
  });
  if (admission.kind === 'credential_only') {
    return {
      env: { ...withoutClaudeConfigDirOverrides(params.processEnv), CLAUDE_CONFIG_DIR: params.claudeConfigDir },
      sessionStateMode: 'existing',
      checksSourceScope: false,
    };
  }
  return {
    env: claudeNativeSourceEnv(admission.source, params.processEnv),
    nativeSource: admission.source,
    checksSourceScope: true,
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
  /**
   * Who may name the native source: the producing caller's `processEnv`, or only the home's record
   * (rematerialization and account switch; `processEnv` is then never a source).
   */
  nativeSourceAuthority: ConnectedServiceNativeSourceAuthority;
  /** The session's current home, whose record a never-produced home inherits under `recorded`. */
  previousClaudeConfigDir?: string | null;
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
    let groupSource: (AdmittedClaudeSource & Readonly<{ originSourceEnv: NodeJS.ProcessEnv }>) | null = null;
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
        // The canonical member home carries the group's native source. A member home not yet produced
        // (a new active member) inherits the session's previous home when the caller names one (a
        // switch), else the group home's record. The group home must agree before either home is
        // read or written.
        const profileSource = await admitClaudeSource({
          nativeSourceAuthority: params.nativeSourceAuthority,
          claudeConfigDir: profileClaudeConfigDir,
          previousClaudeConfigDir: params.previousClaudeConfigDir ?? claudeConfigDir,
          requestedEnv: resolveClaudeConfigurationSourceEnv({
            activeServerDir: params.activeServerDir,
            processEnv: params.processEnv,
            targetClaudeConfigDir: profileClaudeConfigDir,
          }),
          processEnv: params.processEnv,
          sessionStateMode: params.sessionStateMode,
        });
        const groupNativeSource = await resolveClaudeMemberOrigin(profileSource.nativeSource, profileClaudeConfigDir);
        // The group home is admitted on its own record, before either home is written. Its record
        // is read (an invalid one refuses) whatever the member's admission was.
        const groupProvenance = await readClaudeHomeProvenance(claudeConfigDir);
        if (groupNativeSource) {
          await assertClaudeHomeSourceAgrees({
            claudeConfigDir,
            provenance: groupProvenance.kind === 'recorded' && isClaudeSelfSource(groupProvenance.source, claudeConfigDir)
              ? null
              : groupProvenance,
            source: groupNativeSource,
          });
        } else if (!profileSource.checksSourceScope && groupProvenance.kind === 'absent') {
          // A credential-only member names no source, so it gives a never-produced group home none to
          // inherit: that home is refused exactly as its own admission would refuse it.
          throw new ConnectedServiceNativeSourceProvenanceError(
            'connected_service_native_source_unrecorded',
            claudeConfigDir,
            `Claude connected-service group home ${claudeConfigDir} records no admitted native source and its `
              + 'member home records none to inherit; refusing to produce it',
          );
        }
        const profileSourceEnv = profileSource.env;
        const profileSourceViolation = profileSource.checksSourceScope ? await findClaudeConfigurationSourceScopeViolation({
          sourceEnv: profileSourceEnv,
          targetDir: profileClaudeConfigDir,
          managedHomesRoot: resolveConnectedServiceManagedHomesRoot(params.activeServerDir),
          permittedManagedHome: null,
          serviceId: params.serviceId,
        }) : null;
        if (profileSourceViolation) {
          return sourceScopeRefusal({ claudeConfigDir, diagnostic: profileSourceViolation });
        }
        const canonicalProfileMaterialized = await materializeClaudeSubscriptionNativeAuthHome({
          record: params.record,
          targetClaudeConfigDir: profileClaudeConfigDir,
          sourceEnv: profileSourceEnv,
          nativeSource: profileSource.nativeSource,
          accountSettings: params.accountSettings ?? null,
          sessionDirectory: params.sessionDirectory ?? null,
          vendorResumeId: params.vendorResumeId ?? null,
          candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
          sessionStateMode: profileSource.sessionStateMode,
          managedHomesRoot: resolveConnectedServiceManagedHomesRoot(params.activeServerDir),
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
        // A member whose source is unknown (credential-only) leaves the group home credential-only too.
        groupSource = {
          env: { ...params.processEnv, ...canonicalProfileMaterialized.env },
          // The native source behind the member, which the member's retained links point into: for a
          // member that is its own source, the origin it records rather than the member home.
          originSourceEnv: groupNativeSource && groupNativeSource !== profileSource.nativeSource
            ? claudeNativeSourceEnv(groupNativeSource, params.processEnv)
            : profileSourceEnv,
          nativeSource: groupNativeSource,
          sessionStateMode: profileSource.sessionStateMode,
          checksSourceScope: profileSource.checksSourceScope,
        };
      }
    }
    const homeSource: AdmittedClaudeSource = groupSource ?? await admitClaudeSource({
      nativeSourceAuthority: params.nativeSourceAuthority,
      claudeConfigDir,
      previousClaudeConfigDir: params.previousClaudeConfigDir ?? null,
      requestedEnv: resolveClaudeConfigurationSourceEnv({
        activeServerDir: params.activeServerDir,
        processEnv: params.processEnv,
        targetClaudeConfigDir: claudeConfigDir,
      }),
      processEnv: params.processEnv,
      sessionStateMode: params.sessionStateMode,
    });
    const sourceEnv = homeSource.env;
    const sourceViolation = homeSource.checksSourceScope && await findClaudeConfigurationSourceScopeViolation({
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
      // A group home reads through its member home but records the native source behind it.
      nativeSource: homeSource.nativeSource,
      accountSettings: params.accountSettings ?? null,
      sessionDirectory: params.sessionDirectory ?? null,
      vendorResumeId: params.vendorResumeId ?? null,
      candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
      sessionStateMode: homeSource.sessionStateMode,
      managedHomesRoot: resolveConnectedServiceManagedHomesRoot(params.activeServerDir),
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

  // This path has always imported from the configured dir as given, including a managed home it
  // names directly.
  const apiKeySource = await admitClaudeSource({
    nativeSourceAuthority: params.nativeSourceAuthority,
    claudeConfigDir,
    previousClaudeConfigDir: params.previousClaudeConfigDir ?? null,
    requestedEnv: params.processEnv,
    processEnv: params.processEnv,
    sessionStateMode: params.sessionStateMode,
  });
  if (apiKeySource.sessionStateMode !== 'existing') {
    const managedHomesRoot = resolveConnectedServiceManagedHomesRoot(params.activeServerDir);
    const configuredSourceDir = resolveConfiguredClaudeConfigDir({ env: apiKeySource.env });
    const sourceViolation = await findClaudeConfigurationSourceScopeViolation({
      sourceEnv: apiKeySource.env,
      targetDir: claudeConfigDir,
      managedHomesRoot,
      // Only entries that resolve elsewhere than they appear are refused here.
      permittedManagedHome: isWithinDir(configuredSourceDir, managedHomesRoot) ? configuredSourceDir : null,
      serviceId: params.serviceId,
    });
    if (sourceViolation) {
      return sourceScopeRefusal({ claudeConfigDir, diagnostic: sourceViolation });
    }
  }
  const diagnostics = apiKeySource.sessionStateMode === 'existing' ? [] : (await syncClaudeConnectedServiceHome({
    sourceEnv: apiKeySource.env,
    nativeSource: apiKeySource.nativeSource,
    targetDir: claudeConfigDir,
    accountSettings: params.accountSettings ?? null,
    sessionDirectory: params.sessionDirectory ?? null,
    managedHomesRoot: resolveConnectedServiceManagedHomesRoot(params.activeServerDir),
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
