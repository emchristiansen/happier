import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { resolveHomeDirFromEnvironment } from '@happier-dev/cli-common/providers';

import type { ConnectedServicesMaterializationDiagnostic } from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import { resolveClaudeConfigDirOverride } from '@/backends/claude/utils/resolveClaudeConfigDirOverride';
import { resolveConfiguredClaudeConfigDir } from '@/backends/claude/utils/resolveConfiguredClaudeConfigDir';
import { claudeConnectedServiceStateSharingDescriptor } from './claudeConnectedServiceStateSharingDescriptor';
import { resolveClaudeRootConfigPathCandidates } from './materializeClaudeWorkspaceTrust';

export const CLAUDE_CONFIGURATION_SOURCE_OUTSIDE_PERMITTED_SCOPE = 'claude_configuration_source_outside_permitted_scope';

type ScopeViolationReason =
  | 'resolves_to_managed_home'
  | 'resolves_to_ambient_home_config'
  | 'source_identity_unresolved';

/** The physical identity of a path, established from metadata alone; its contents are never opened. */
type ResolvedIdentity =
  | Readonly<{ kind: 'resolved'; realPath: string }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unresolved' }>;

/**
 * Whether `path` is `root` or lies beneath it. Containment is decided by the first path component of
 * the relative path: only an actual parent component `..` (or an absolute result, such as another
 * drive) leaves the root. A legal child name that merely begins with dots, such as `..nested`, stays
 * inside.
 */
export function isPathWithinDirectory(path: string, root: string): boolean {
  const rel = relative(root, path);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return rel.split(sep)[0] !== '..';
}

const isWithin = isPathWithinDirectory;

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Resolves a path's physical location with a single `realpath`. A missing path (including a dangling
 * link) has nothing to read; any other failure, such as a permission denial, leaves the identity
 * unresolved, which callers treat as a refusal rather than a guess.
 */
async function resolveIdentity(path: string): Promise<ResolvedIdentity> {
  try {
    return { kind: 'resolved', realPath: await realpath(path) };
  } catch (error) {
    return isMissingPathError(error) ? { kind: 'absent' } : { kind: 'unresolved' };
  }
}

/** Like `resolveIdentity`, but an entry that is itself a dangling link is absent, not unresolved. */
async function resolveEntryIdentity(path: string): Promise<ResolvedIdentity> {
  try {
    await lstat(path);
  } catch (error) {
    return isMissingPathError(error) ? { kind: 'absent' } : { kind: 'unresolved' };
  }
  return await resolveIdentity(path);
}

/** The physical root a lookup compares against; a missing root keeps its lexical location. */
function rootOf(path: string, identity: ResolvedIdentity): string | null {
  if (identity.kind === 'resolved') return identity.realPath;
  if (identity.kind === 'absent') return resolve(path);
  return null;
}

/**
 * The physical directory and root config files of an origin source that already passed this check
 * for its own materialization, so its links are known to be permitted.
 */
async function resolveOriginSourceRoots(env: NodeJS.ProcessEnv): Promise<string[] | null> {
  const paths = [
    resolveConfiguredClaudeConfigDir({ env }),
    ...resolveClaudeRootConfigPathCandidates(env).map((candidate) => candidate.path),
  ];
  const roots: string[] = [];
  for (const path of paths) {
    const root = rootOf(path, await resolveIdentity(path));
    if (!root) return null;
    roots.push(root);
  }
  return roots;
}

/**
 * Checks, before any source content is read, that every Claude configuration entry materialization
 * would read from the source physically resolves to a permitted location.
 *
 * A path that looks permitted can still dereference elsewhere: a source `.claude.json` or
 * `settings.json` symlinked into the ambient HOME's Claude config, or into another Happier-managed
 * account home, possibly through a source directory that encloses those homes. Exclusion therefore
 * wins over containment in the source directory. Two locations are excluded:
 *
 * - the managed homes root, except the one particular managed home this materialization was
 *   deliberately given as its source (a group's canonical member home);
 * - when the source names an explicit config dir, the ambient HOME's `.claude.json` and `.claude`,
 *   except through a permitted source that is one of them or lies inside one.
 *
 * `permittedOriginSourceEnv` carries the native source a managed source was materialized from, so
 * the links that materialization deliberately keeps (settings, shared state) remain permitted when
 * the managed home is composed into a group. Other links, for example into a dotfiles checkout,
 * remain allowed. Identity is established with metadata (`lstat`/`realpath`) on the source entries
 * and on the two named ambient exclusion paths only; an unresolvable identity refuses.
 *
 * Returns null when the source is the target itself, which imports nothing.
 */
export async function findClaudeConfigurationSourceScopeViolation(params: Readonly<{
  sourceEnv: NodeJS.ProcessEnv;
  targetDir: string;
  managedHomesRoot: string;
  /** The particular managed home deliberately used as the source, if any; no other is permitted. */
  permittedManagedHome: string | null;
  permittedOriginSourceEnv?: NodeJS.ProcessEnv | null;
  serviceId: ConnectedServicesMaterializationDiagnostic['serviceId'];
}>): Promise<ConnectedServicesMaterializationDiagnostic | null> {
  const sourceDir = resolveConfiguredClaudeConfigDir({ env: params.sourceEnv });
  if (resolve(sourceDir) === resolve(params.targetDir)) return null;

  const violation = (entryName: string, reason: ScopeViolationReason): ConnectedServicesMaterializationDiagnostic => ({
    code: CLAUDE_CONFIGURATION_SOURCE_OUTSIDE_PERMITTED_SCOPE,
    providerId: 'claude',
    severity: 'blocking',
    serviceId: params.serviceId,
    entryName,
    reason,
  });

  const managedHomesRoot = rootOf(params.managedHomesRoot, await resolveIdentity(params.managedHomesRoot));
  const permittedManagedHome = params.permittedManagedHome
    ? rootOf(params.permittedManagedHome, await resolveIdentity(params.permittedManagedHome))
    : null;
  // Only the source directory itself is a permitted root: its entries, including its root config,
  // are exactly what this check is about to judge, so their link targets grant nothing.
  const realSourceDir = rootOf(sourceDir, await resolveIdentity(sourceDir));
  const originRoots = params.permittedOriginSourceEnv
    ? await resolveOriginSourceRoots(params.permittedOriginSourceEnv)
    : [];
  if (!managedHomesRoot || (params.permittedManagedHome && !permittedManagedHome) || !realSourceDir || !originRoots) {
    return violation('.', 'source_identity_unresolved');
  }
  const permittedRoots = [realSourceDir, ...originRoots];

  const isPermittedManaged = (path: string): boolean =>
    permittedManagedHome !== null && isWithin(path, permittedManagedHome);
  if (isWithin(realSourceDir, managedHomesRoot) && !isPermittedManaged(realSourceDir)) {
    return violation('.', 'resolves_to_managed_home');
  }

  const ambientExcludedRoots: string[] = [];
  if (resolveClaudeConfigDirOverride(params.sourceEnv)) {
    const homeDir = resolveHomeDirFromEnvironment(params.sourceEnv);
    for (const path of [join(homeDir, '.claude.json'), join(homeDir, '.claude')]) {
      const root = rootOf(path, await resolveIdentity(path));
      if (!root) return violation('.', 'source_identity_unresolved');
      ambientExcludedRoots.push(root);
    }
  }

  const entries: Array<Readonly<{ name: string; path: string }>> = [
    ...resolveClaudeRootConfigPathCandidates(params.sourceEnv)
      .filter((candidate) => resolve(candidate.rootDir) !== resolve(params.targetDir))
      .map((candidate) => ({ name: relative(sourceDir, candidate.path) || '.claude.json', path: candidate.path })),
    ...[
      ...claudeConnectedServiceStateSharingDescriptor.config.entries,
      ...claudeConnectedServiceStateSharingDescriptor.state.entries,
    ].map((entry) => ({ name: entry.path, path: join(sourceDir, entry.path) })),
  ];
  for (const entry of entries) {
    const identity = await resolveEntryIdentity(entry.path);
    if (identity.kind === 'absent') continue;
    if (identity.kind === 'unresolved') return violation(entry.name, 'source_identity_unresolved');
    const resolved = identity.realPath;
    if (isWithin(resolved, managedHomesRoot) && !isPermittedManaged(resolved)) {
      return violation(entry.name, 'resolves_to_managed_home');
    }
    // An ambient root is exempt only through a permitted source that is that root or lies inside it;
    // a permitted directory merely enclosing the ambient config does not authorize reading it.
    const excludedAmbientRoot = ambientExcludedRoots.find((root) =>
      isWithin(resolved, root)
      && !permittedRoots.some((permitted) => isWithin(permitted, root) && isWithin(resolved, permitted)));
    if (excludedAmbientRoot) {
      return violation(entry.name, 'resolves_to_ambient_home_config');
    }
  }
  return null;
}
