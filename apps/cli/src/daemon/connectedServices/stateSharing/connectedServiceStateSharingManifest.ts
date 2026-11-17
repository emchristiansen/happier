import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type { ConnectedServicesMaterializationDiagnostic } from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

export type ConnectedServiceStateSharingMode = 'shared' | 'isolated';

export type ConnectedServiceStateSharingSessionFileMappingV1 = Readonly<{
  vendorResumeId: string;
  sourcePath: string | null;
  destinationPath: string;
  importedAtMs: number;
  verifiedAtMs: number | null;
}>;

export type ConnectedServiceStateSharingManifestV1 = Readonly<{
  v: 1;
  requestedStateMode: ConnectedServiceStateSharingMode;
  effectiveStateMode: ConnectedServiceStateSharingMode;
  lastSyncAtMs: number;
  configEntries: readonly string[];
  stateEntries: readonly string[];
  sessionFileMappings: readonly ConnectedServiceStateSharingSessionFileMappingV1[];
  diagnostics: readonly ConnectedServicesMaterializationDiagnostic[];
  /**
   * The provider-native source locations admitted by the caller that produced this target, as the
   * exact source-location environment values its materializer resolved (never the whole caller
   * environment). Absent for targets synced before provenance was recorded.
   */
  nativeSourceEnv?: Readonly<Record<string, string>>;
}>;

const EMPTY_MANIFEST: ConnectedServiceStateSharingManifestV1 = Object.freeze({
  v: 1,
  requestedStateMode: 'isolated',
  effectiveStateMode: 'isolated',
  lastSyncAtMs: 0,
  configEntries: [],
  stateEntries: [],
  sessionFileMappings: [],
  diagnostics: [],
});

export const DEFAULT_MANIFEST_NAME = '.happier-state-sharing.json';
export const LEGACY_CODEX_MANIFEST_NAME = '.happier-codex-home-sharing.json';

export function isSafeConnectedServiceStateSharingEntry(entry: unknown): entry is string {
  if (typeof entry !== 'string' || entry.length === 0 || isAbsolute(entry)) return false;
  return !entry.split(/[\\/]+/).includes('..');
}

function parseStateMode(value: unknown): ConnectedServiceStateSharingMode {
  return value === 'shared' ? 'shared' : 'isolated';
}

function parseNonNegativeInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function parseDiagnostics(value: unknown): readonly ConnectedServicesMaterializationDiagnostic[] {
  if (!Array.isArray(value)) return [];
  const diagnostics: ConnectedServicesMaterializationDiagnostic[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.code !== 'string' || typeof record.providerId !== 'string') continue;
    diagnostics.push({
      code: record.code,
      providerId: record.providerId as ConnectedServicesMaterializationDiagnostic['providerId'],
      ...(typeof record.serviceId === 'string'
        ? { serviceId: record.serviceId as ConnectedServicesMaterializationDiagnostic['serviceId'] }
        : {}),
      ...(typeof record.requestedStateMode === 'string' ? { requestedStateMode: record.requestedStateMode } : {}),
      ...(typeof record.effectiveStateMode === 'string' ? { effectiveStateMode: record.effectiveStateMode } : {}),
      ...(typeof record.entryName === 'string' ? { entryName: record.entryName } : {}),
      ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
    });
  }
  return diagnostics;
}

function parseSessionFileMappings(value: unknown): readonly ConnectedServiceStateSharingSessionFileMappingV1[] {
  if (!Array.isArray(value)) return [];
  const mappings: ConnectedServiceStateSharingSessionFileMappingV1[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.vendorResumeId !== 'string' || record.vendorResumeId.trim().length === 0) continue;
    if (typeof record.destinationPath !== 'string' || record.destinationPath.trim().length === 0) continue;
    mappings.push({
      vendorResumeId: record.vendorResumeId,
      sourcePath: typeof record.sourcePath === 'string'
        ? record.sourcePath
        : record.sourcePath === null
          ? null
          : null,
      destinationPath: record.destinationPath,
      importedAtMs: parseNonNegativeInteger(record.importedAtMs, 0),
      verifiedAtMs: record.verifiedAtMs === null
        ? null
        : parseNonNegativeInteger(record.verifiedAtMs, 0),
    });
  }
  return mappings;
}

function parseNativeSourceEnv(value: unknown): Readonly<Record<string, string>> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return null;
  const env: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (typeof entry !== 'string' || entry.length === 0 || !isAbsolute(entry)) return null;
    env[key] = entry;
  }
  return env;
}

function parseManifest(value: unknown): ConnectedServiceStateSharingManifestV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY_MANIFEST;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return EMPTY_MANIFEST;
  return {
    v: 1,
    requestedStateMode: parseStateMode(record.requestedStateMode),
    effectiveStateMode: parseStateMode(record.effectiveStateMode),
    lastSyncAtMs: parseNonNegativeInteger(record.lastSyncAtMs, 0),
    configEntries: Array.isArray(record.configEntries)
      ? record.configEntries.filter(isSafeConnectedServiceStateSharingEntry)
      : [],
    stateEntries: Array.isArray(record.stateEntries)
      ? record.stateEntries.filter(isSafeConnectedServiceStateSharingEntry)
      : [],
    sessionFileMappings: parseSessionFileMappings(record.sessionFileMappings),
    diagnostics: parseDiagnostics(record.diagnostics),
    ...(() => {
      const nativeSourceEnv = parseNativeSourceEnv(record.nativeSourceEnv);
      return nativeSourceEnv ? { nativeSourceEnv } : {};
    })(),
  };
}

function resolveManifestPath(destinationHome: string, manifestName = DEFAULT_MANIFEST_NAME): string {
  return join(destinationHome, manifestName);
}

async function tryReadParsedManifest(path: string): Promise<ConnectedServiceStateSharingManifestV1 | null> {
  try {
    return parseManifest(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
}

export async function readConnectedServiceStateSharingManifest(
  destinationHome: string,
  manifestName?: string,
): Promise<ConnectedServiceStateSharingManifestV1> {
  const primary = await tryReadParsedManifest(resolveManifestPath(destinationHome, manifestName));
  if (primary) return primary;
  if (manifestName) return EMPTY_MANIFEST;
  const legacy = await tryReadParsedManifest(resolveManifestPath(destinationHome, LEGACY_CODEX_MANIFEST_NAME));
  if (legacy) return legacy;
  return EMPTY_MANIFEST;
}

/**
 * What a target's state-sharing manifest says about its admitted native source, without the generic
 * reader's normalization. The generic reader turns an unreadable file, invalid JSON, an unsupported
 * version and a malformed `nativeSourceEnv` into "no record"; provenance consumers must not, because
 * an occupied target with an untrustworthy record is not a fresh target.
 *
 * - `absent`: a never-produced target: no manifest entry, and the target is missing or empty.
 * - `unrecorded`: an occupied target without a provenance record: a valid manifest written before
 *   provenance was recorded, or content with no manifest entry at all.
 * - `recorded`: a valid, well-formed record (every value an absolute path).
 * - `invalid`: a manifest entry exists but cannot be read or trusted (including a dangling link), or
 *   the target itself cannot be inspected.
 *
 * Freshness is never inferred from a failed read alone: only a missing entry plus a missing or empty
 * target is `absent`.
 */
export type ConnectedServiceStateSharingNativeSourceRecord =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unrecorded' }>
  | Readonly<{ kind: 'recorded'; nativeSourceEnv: Readonly<Record<string, string>> }>
  | Readonly<{ kind: 'invalid'; manifestPath: string; reason: string }>;

export async function readConnectedServiceStateSharingNativeSourceRecord(
  destinationHome: string,
): Promise<ConnectedServiceStateSharingNativeSourceRecord> {
  // Same file precedence as the generic reader: the current manifest, else the legacy Codex one.
  for (const manifestName of [DEFAULT_MANIFEST_NAME, LEGACY_CODEX_MANIFEST_NAME]) {
    const manifestPath = resolveManifestPath(destinationHome, manifestName);
    let content: string;
    try {
      content = await readFile(manifestPath, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        const entry = await inspectPathEntry(manifestPath);
        if (entry === 'missing') continue;
        return { kind: 'invalid', manifestPath, reason: entry === 'present' ? 'dangling link' : entry.reason };
      }
      return { kind: 'invalid', manifestPath, reason: `unreadable (${code ?? 'unknown error'})` };
    }
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      return { kind: 'invalid', manifestPath, reason: 'invalid JSON' };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { kind: 'invalid', manifestPath, reason: 'not a JSON object' };
    }
    const record = value as Record<string, unknown>;
    if (record.v !== 1) return { kind: 'invalid', manifestPath, reason: 'unsupported manifest version' };
    if (!Object.prototype.hasOwnProperty.call(record, 'nativeSourceEnv')) return { kind: 'unrecorded' };
    const nativeSourceEnv = parseNativeSourceEnv(record.nativeSourceEnv);
    return nativeSourceEnv
      ? { kind: 'recorded', nativeSourceEnv }
      : { kind: 'invalid', manifestPath, reason: 'malformed nativeSourceEnv' };
  }
  // No manifest entry at all. Only a missing or empty target is never-produced; anything already in
  // it has unknown provenance.
  let entries: string[];
  try {
    entries = await readdir(destinationHome);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'invalid', manifestPath: destinationHome, reason: `target unreadable (${code ?? 'unknown error'})` };
  }
  return entries.length === 0 ? { kind: 'absent' } : { kind: 'unrecorded' };
}

/** Whether a path names a directory entry, without following a final symlink. */
async function inspectPathEntry(path: string): Promise<'missing' | 'present' | Readonly<{ reason: string }>> {
  try {
    await lstat(path);
    return 'present';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === 'ENOENT' ? 'missing' : { reason: `uninspectable (${code ?? 'unknown error'})` };
  }
}

export async function removeLegacyConnectedServiceStateSharingManifest(destinationHome: string): Promise<void> {
  await rm(resolveManifestPath(destinationHome, LEGACY_CODEX_MANIFEST_NAME), { force: true });
}

export async function writeConnectedServiceStateSharingManifest(
  destinationHome: string,
  manifest: ConnectedServiceStateSharingManifestV1,
  manifestName?: string,
): Promise<void> {
  const normalized = parseManifest(manifest);
  await writeJsonAtomic(resolveManifestPath(destinationHome, manifestName), normalized);
  if (!manifestName || manifestName === DEFAULT_MANIFEST_NAME) {
    await rm(resolveManifestPath(destinationHome, LEGACY_CODEX_MANIFEST_NAME), { force: true });
  }
}

export async function removeConnectedServiceStateSharingManifestEntries(
  destinationHome: string,
  entryNames: readonly string[],
): Promise<void> {
  for (const entryName of entryNames) {
    if (!isSafeConnectedServiceStateSharingEntry(entryName)) continue;
    await rm(join(destinationHome, entryName), { recursive: true, force: true });
  }
}
