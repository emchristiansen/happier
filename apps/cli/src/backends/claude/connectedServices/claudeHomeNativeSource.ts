import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { resolveHomeDirFromEnvironment } from '@happier-dev/cli-common/providers';

import {
  ConnectedServiceNativeSourceProvenanceError,
  type ConnectedServiceNativeSourceAuthority,
} from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import { readConnectedServiceStateSharingNativeSourceRecord } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';
import { resolveClaudeConfigDirOverride } from '@/backends/claude/utils/resolveClaudeConfigDirOverride';

/**
 * The native Claude configuration source a managed home is produced from, in the operands Claude's
 * own reader uses (`resolveConfiguredClaudeConfigDir`, `resolveClaudeRootConfigPathCandidates`):
 *
 * - `config_dir`: an explicit config dir (`CLAUDE_CONFIG_DIR`, or `HAPPIER_CLAUDE_CONFIG_DIR`). Its
 *   settings, instructions, history and root `.claude.json` all live in that dir; HOME only names
 *   the ambient config the scope check excludes, so it is carried but is not part of the identity.
 * - `home`: no override. The config dir is `HOME/.claude` and the root config is `HOME/.claude.json`
 *   (or the one inside `.claude`), so HOME is the identity.
 *
 * A home whose config dir is itself is its own source (nothing is imported or linked). Identity is a
 * location, never the source's mutable contents.
 */
export type ClaudeAdmittedNativeSource =
  | Readonly<{ kind: 'config_dir'; configDir: string; home: string }>
  | Readonly<{ kind: 'home'; home: string }>;

/** The source a caller's environment names, exactly as the Claude reader would resolve it. */
export function claudeNativeSourceFromEnv(env: NodeJS.ProcessEnv): ClaudeAdmittedNativeSource {
  const home = resolve(resolveHomeDirFromEnvironment(env));
  const override = resolveClaudeConfigDirOverride(env);
  return override
    ? { kind: 'config_dir', configDir: resolve(override), home }
    : { kind: 'home', home };
}

/**
 * The environment that makes the Claude reader resolve exactly this source; the rest of `baseEnv` is
 * kept. The home is every operand the reader may take it from (`resolveHomeDirFromEnvironment`:
 * `USERPROFILE` before `HOME` on Windows), so no ambient one can win.
 */
export function claudeNativeSourceEnv(source: ClaudeAdmittedNativeSource, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv, HOME: source.home, USERPROFILE: source.home };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.HAPPIER_CLAUDE_CONFIG_DIR;
  return source.kind === 'config_dir' ? { ...env, CLAUDE_CONFIG_DIR: source.configDir } : env;
}

/** The manifest record of a source: only the operands that select it. */
export function claudeNativeSourceRecordEnv(source: ClaudeAdmittedNativeSource): Readonly<Record<string, string>> {
  return source.kind === 'config_dir'
    ? { CLAUDE_CONFIG_DIR: source.configDir, HOME: source.home }
    : { HOME: source.home };
}

export function isClaudeSelfSource(source: ClaudeAdmittedNativeSource, claudeConfigDir: string): boolean {
  return source.kind === 'config_dir' && resolve(source.configDir) === resolve(claudeConfigDir);
}

/**
 * Physical identity of one source location, from metadata only. A missing location keeps its lexical
 * spelling; any other failure leaves the identity unknown, which never counts as equal.
 */
async function physicalLocation(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? resolve(path) : null;
  }
}

/**
 * Whether two sources are the same effective source. Spellings are compared first; only differing
 * spellings are resolved, and only by `realpath` of the identifying location (no contents are read).
 */
export async function isSameClaudeNativeSource(
  left: ClaudeAdmittedNativeSource,
  right: ClaudeAdmittedNativeSource,
): Promise<boolean> {
  if (left.kind !== right.kind) return false;
  const [a, b] = left.kind === 'config_dir' && right.kind === 'config_dir'
    ? [left.configDir, right.configDir]
    : [left.home, right.home];
  if (resolve(a) === resolve(b)) return true;
  const [physicalA, physicalB] = await Promise.all([physicalLocation(a), physicalLocation(b)]);
  return physicalA !== null && physicalA === physicalB;
}

/** A Claude home's provenance; see `readConnectedServiceStateSharingNativeSourceRecord`. */
export type ClaudeHomeProvenance =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unrecorded' }>
  | Readonly<{ kind: 'recorded'; source: ClaudeAdmittedNativeSource }>;

function parseClaudeNativeSourceRecord(env: Readonly<Record<string, string>>): ClaudeAdmittedNativeSource | null {
  const home = env.HOME;
  if (!home || !isAbsolute(home)) return null;
  const configDir = env.CLAUDE_CONFIG_DIR;
  if (configDir === undefined) return { kind: 'home', home };
  return isAbsolute(configDir) ? { kind: 'config_dir', configDir, home } : null;
}

export async function readClaudeHomeProvenance(claudeConfigDir: string): Promise<ClaudeHomeProvenance> {
  const record = await readConnectedServiceStateSharingNativeSourceRecord(claudeConfigDir);
  if (record.kind === 'absent' || record.kind === 'unrecorded') return record;
  if (record.kind === 'recorded') {
    const source = parseClaudeNativeSourceRecord(record.nativeSourceEnv);
    if (source) return { kind: 'recorded', source };
  }
  const reason = record.kind === 'invalid' ? `${record.manifestPath}: ${record.reason}` : 'incomplete Claude source record';
  throw new ConnectedServiceNativeSourceProvenanceError(
    'connected_service_native_source_invalid',
    claudeConfigDir,
    `Claude connected-service home ${claudeConfigDir} has an untrustworthy native source record (${reason}); `
      + 'refusing to use it',
  );
}

function describe(source: ClaudeAdmittedNativeSource): string {
  return source.kind === 'config_dir' ? source.configDir : `${source.home} (default config)`;
}

export class ClaudeConnectedServiceNativeSourceConflictError extends ConnectedServiceNativeSourceProvenanceError {
  constructor(
    readonly claudeConfigDir: string,
    readonly recorded: ClaudeAdmittedNativeSource,
    readonly requested: ClaudeAdmittedNativeSource,
  ) {
    super(
      'connected_service_native_source_conflict',
      claudeConfigDir,
      `Claude connected-service home ${claudeConfigDir} was produced from native source ${describe(recorded)}; `
        + `refusing to materialize it from ${describe(requested)}`,
    );
    this.name = 'ClaudeConnectedServiceNativeSourceConflictError';
  }
}

/** Refuses when `provenance` records a source other than `source`; nothing else is checked. */
export async function assertClaudeHomeSourceAgrees(params: Readonly<{
  claudeConfigDir: string;
  provenance: ClaudeHomeProvenance | null;
  source: ClaudeAdmittedNativeSource;
}>): Promise<void> {
  if (params.provenance?.kind !== 'recorded') return;
  if (await isSameClaudeNativeSource(params.provenance.source, params.source)) return;
  throw new ClaudeConnectedServiceNativeSourceConflictError(params.claudeConfigDir, params.provenance.source, params.source);
}

/**
 * What a Claude materialization may do with its native source: read and record `source`, or (a
 * rematerialization of a home produced before sources were recorded) publish credentials only,
 * reading and linking nothing, so the home keeps the links its producer made.
 */
export type ClaudeNativeSourceAdmission =
  | Readonly<{ kind: 'source'; source: ClaudeAdmittedNativeSource }>
  | Readonly<{ kind: 'credential_only' }>;

/**
 * Decide, before any scope check, lock, read or write, which native source a Claude home may be
 * materialized from. The rule matches Codex's:
 *
 * - `caller_env`: the caller's own source. Refused if the home (or the session's previous home)
 *   records a different effective source. A caller that names no permitted source (its config dir
 *   is the home itself) materializes the home as its own source and leaves any record alone.
 * - `recorded`: the home's record; a never-produced home inherits the previous home's record. A
 *   legacy home produced before sources were recorded is rematerialized credential-only (its unknown
 *   source is neither read nor replaced); a never-produced home with nothing to inherit is refused.
 *   The rematerializer's own environment is never a source.
 *
 * An invalid record is refused, never inherited around.
 */
export async function admitClaudeNativeSource(params: Readonly<{
  nativeSourceAuthority: ConnectedServiceNativeSourceAuthority;
  claudeConfigDir: string;
  previousClaudeConfigDir: string | null;
  requested: ClaudeAdmittedNativeSource;
}>): Promise<ClaudeNativeSourceAdmission> {
  const destination = await readClaudeHomeProvenance(params.claudeConfigDir);
  const previousRecorded = params.previousClaudeConfigDir
    && resolve(params.previousClaudeConfigDir) !== resolve(params.claudeConfigDir)
    ? await readClaudeHomeProvenance(params.previousClaudeConfigDir)
    : null;
  // A home recorded as its own source has no native source yet: no other source conflicts with it.
  const previousSelf = previousRecorded?.kind === 'recorded'
    && isClaudeSelfSource(previousRecorded.source, params.previousClaudeConfigDir ?? '');
  const previous = previousSelf ? null : previousRecorded;
  const destinationSelf = destination.kind === 'recorded' && isClaudeSelfSource(destination.source, params.claudeConfigDir);
  if (params.nativeSourceAuthority === 'caller_env') {
    if (isClaudeSelfSource(params.requested, params.claudeConfigDir)) return { kind: 'source', source: params.requested };
    await assertClaudeHomeSourceAgrees({
      claudeConfigDir: params.claudeConfigDir, provenance: destinationSelf ? null : destination, source: params.requested,
    });
    await assertClaudeHomeSourceAgrees({ claudeConfigDir: params.claudeConfigDir, provenance: previous, source: params.requested });
    return { kind: 'source', source: params.requested };
  }
  if (destination.kind === 'recorded') {
    if (!destinationSelf) {
      await assertClaudeHomeSourceAgrees({ claudeConfigDir: params.claudeConfigDir, provenance: previous, source: destination.source });
    }
    return { kind: 'source', source: destination.source };
  }
  if (destination.kind === 'absent' && previousRecorded?.kind === 'recorded') {
    // A never-produced home inherits the previous home's source; a previous home that was its own
    // source passes on "no native source", so this home is its own source too.
    return {
      kind: 'source',
      source: previousSelf
        ? { kind: 'config_dir', configDir: resolve(params.claudeConfigDir), home: previousRecorded.source.home }
        : previousRecorded.source,
    };
  }
  if (destination.kind === 'unrecorded') return { kind: 'credential_only' };
  throw new ConnectedServiceNativeSourceProvenanceError(
    'connected_service_native_source_unrecorded',
    params.claudeConfigDir,
    `Claude connected-service home ${params.claudeConfigDir} records no admitted native source; `
      + 'refusing to rematerialize it from any other source',
  );
}
