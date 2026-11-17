import { ConnectedServiceNativeSourceProvenanceError } from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import {
  readConnectedServiceStateSharingManifest,
  readConnectedServiceStateSharingNativeSourceRecord,
} from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';

import { resolveConfiguredCodexSqliteHome } from './codexStateFileNames';

/**
 * The exact native source locations a Codex home was produced from: the configuration/state source
 * root and the SQLite home. Recorded in the target's state-sharing manifest; never the whole caller
 * environment.
 */
export type CodexAdmittedNativeSource = Readonly<{ CODEX_HOME: string; CODEX_SQLITE_HOME: string }>;

export function isSameCodexAdmittedNativeSource(
  left: CodexAdmittedNativeSource,
  right: CodexAdmittedNativeSource,
): boolean {
  return left.CODEX_HOME === right.CODEX_HOME && left.CODEX_SQLITE_HOME === right.CODEX_SQLITE_HOME;
}

/**
 * A Codex home's provenance: never produced (`absent`: no manifest entry and a missing or empty
 * home), occupied without a record (`unrecorded`: a pre-provenance manifest, or content with no
 * manifest), or recorded. A manifest that cannot be read (including a dangling link), or whose
 * record is not a complete absolute Codex source pair, is refused here, never treated as absent.
 */
export type CodexHomeProvenance =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unrecorded' }>
  | Readonly<{ kind: 'recorded'; source: CodexAdmittedNativeSource }>;

export async function readCodexHomeProvenance(codexHome: string): Promise<CodexHomeProvenance> {
  const record = await readConnectedServiceStateSharingNativeSourceRecord(codexHome);
  if (record.kind === 'absent' || record.kind === 'unrecorded') return record;
  if (record.kind === 'recorded') {
    const codexHomeSource = record.nativeSourceEnv.CODEX_HOME;
    const sqliteHome = record.nativeSourceEnv.CODEX_SQLITE_HOME;
    if (codexHomeSource && sqliteHome) {
      return { kind: 'recorded', source: { CODEX_HOME: codexHomeSource, CODEX_SQLITE_HOME: sqliteHome } };
    }
  }
  const reason = record.kind === 'invalid' ? `${record.manifestPath}: ${record.reason}` : 'incomplete Codex source record';
  throw new ConnectedServiceNativeSourceProvenanceError(
    'connected_service_native_source_invalid',
    codexHome,
    `Codex connected-service home ${codexHome} has an untrustworthy native source record (${reason}); `
      + 'refusing to use it',
  );
}

/**
 * The SQLite home a materialized Codex connected-service home runs with, chosen as its producer chose
 * it: the home itself when its state is isolated, else the SQLite home of its recorded admitted
 * source. Only a shared home produced before provenance was recorded falls back to the caller's
 * configured SQLite home (its pre-provenance behavior); an untrustworthy record is refused, never
 * replaced by the caller's environment.
 */
export async function resolveCodexConnectedServiceHomeSqliteHome(params: Readonly<{
  codexHome: string;
  processEnv: NodeJS.ProcessEnv;
}>): Promise<string> {
  const manifest = await readConnectedServiceStateSharingManifest(params.codexHome);
  if (manifest.effectiveStateMode !== 'shared') return params.codexHome;
  const provenance = await readCodexHomeProvenance(params.codexHome);
  return provenance.kind === 'recorded'
    ? provenance.source.CODEX_SQLITE_HOME
    : resolveConfiguredCodexSqliteHome(params.processEnv);
}
