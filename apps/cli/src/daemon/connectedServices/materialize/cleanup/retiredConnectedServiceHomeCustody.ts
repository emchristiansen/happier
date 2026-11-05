import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

import { AGENT_IDS } from '@happier-dev/agents';

import type { CatalogAgentId } from '@/backends/types';

/**
 * Durable custody of retained `.previous-*` / `.rejected-*` homes. A retired home keeps its
 * history forever, so its credentials must be revoked by an owner that survives a failed attempt
 * and a daemon restart. Custody is granted only by a record written before the rename that
 * creates the sibling, and is bound to the directory's inode; a matching name alone grants none.
 */
const CUSTODY_DIR_NAME = '.retired-homes';

type RetiredHomeCustodyRecordV1 = Readonly<{
  v: 1;
  agentId: CatalogAgentId;
  /** The retained sibling; `<baseDir>/<identity>/<agentId>.(previous|rejected)-<uuid>`. */
  path: string;
  /** The canonical home renamed into `path`. */
  sourcePath: string;
  dev: string;
  ino: string;
}>;

export type RevokeRetiredHomeCredentials = (input: Readonly<{ rootDir: string; agentId: CatalogAgentId }>) => Promise<void>;

function custodyRecordPath(baseDir: string, retiredPath: string): string {
  const key = createHash('sha256').update(retiredPath).digest('hex').slice(0, 32);
  return join(baseDir, CUSTODY_DIR_NAME, `${key}.json`);
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

async function tryLstatIdentity(path: string): Promise<Readonly<{ dev: string; ino: string; directory: boolean }> | null> {
  try {
    const info = await lstat(path, { bigint: true });
    return { dev: String(info.dev), ino: String(info.ino), directory: info.isDirectory() };
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

/** Records custody before `sourcePath` is renamed to `retiredPath`; a missing source needs none. */
export async function claimRetiredConnectedServiceHome(input: Readonly<{
  baseDir: string;
  agentId: CatalogAgentId;
  sourcePath: string;
  retiredPath: string;
}>): Promise<void> {
  const source = await tryLstatIdentity(input.sourcePath);
  if (!source?.directory) return;
  const record: RetiredHomeCustodyRecordV1 = {
    v: 1, agentId: input.agentId, path: input.retiredPath, sourcePath: input.sourcePath, dev: source.dev, ino: source.ino,
  };
  const recordPath = custodyRecordPath(input.baseDir, input.retiredPath);
  await mkdir(dirname(recordPath), { recursive: true });
  const temporary = `${recordPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, recordPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Ends custody once the retired home's credentials are revoked (or the home is no longer ours). */
export async function releaseRetiredConnectedServiceHomeCustody(baseDir: string, retiredPath: string): Promise<void> {
  try { await unlink(custodyRecordPath(baseDir, retiredPath)); }
  catch (error) { if (!isEnoent(error)) throw error; }
}

function parseCustodyRecord(baseDir: string, recordPath: string, content: string): RetiredHomeCustodyRecordV1 | null {
  let value: unknown;
  try { value = JSON.parse(content); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<RetiredHomeCustodyRecordV1>;
  if (record.v !== 1 || typeof record.path !== 'string' || typeof record.sourcePath !== 'string'
    || typeof record.dev !== 'string' || typeof record.ino !== 'string'
    || !(AGENT_IDS as ReadonlyArray<string>).includes(String(record.agentId))) return null;
  const { path, sourcePath, agentId } = record as RetiredHomeCustodyRecordV1;
  // The record must describe a sibling of this base's canonical home for its own agent.
  const name = basename(path);
  if (!isAbsolute(path) || dirname(path) !== dirname(sourcePath) || dirname(dirname(path)) !== dirname(join(baseDir, agentId))
    || basename(sourcePath) !== agentId
    || !(name.startsWith(`${agentId}.previous-`) || name.startsWith(`${agentId}.rejected-`))
    || custodyRecordPath(baseDir, path) !== recordPath) return null;
  return record as RetiredHomeCustodyRecordV1;
}

/**
 * Revokes credentials of every retired home in custody under `baseDir`. Failures stay in custody
 * for the next pass; history is never removed. Returns per-home failures for the caller to report.
 */
export async function settleRetiredConnectedServiceHomes(input: Readonly<{
  baseDir: string;
  revoke: RevokeRetiredHomeCredentials;
  /** Restricts this pass to retired siblings of one canonical home. */
  sourcePath?: string;
  /**
   * Orders each settlement after any in-flight promotion of the record's canonical home: until a
   * promotion commits, its claimed `.previous-*` sibling may still be restored as the live home.
   */
  serialize?: <T>(sourcePath: string, work: () => Promise<T>) => Promise<T>;
}>): Promise<ReadonlyArray<unknown>> {
  const serialize = input.serialize ?? (async <T>(_sourcePath: string, work: () => Promise<T>) => await work());
  const custodyDir = join(input.baseDir, CUSTODY_DIR_NAME);
  let names: string[];
  try { names = await readdir(custodyDir); } catch (error) {
    return isEnoent(error) ? [] : [error];
  }
  const failures: unknown[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const recordPath = join(custodyDir, name);
    try {
      let content: string;
      try { content = await readFile(recordPath, 'utf8'); } catch (error) {
        if (isEnoent(error)) continue;
        throw error;
      }
      const record = parseCustodyRecord(input.baseDir, recordPath, content);
      if (!record) throw new Error(`Invalid retired connected-service home custody record: ${recordPath}`);
      if (input.sourcePath !== undefined && record.sourcePath !== input.sourcePath) continue;
      await serialize(record.sourcePath, async () => {
        const current = await tryLstatIdentity(record.path);
        if (!current) {
          // The claimed rename did not happen, or a rollback restored it: the canonical home holds it.
          const source = await tryLstatIdentity(record.sourcePath);
          if (source && source.dev === record.dev && source.ino === record.ino) return;
          await releaseRetiredConnectedServiceHomeCustody(input.baseDir, record.path);
          return;
        }
        if (!current.directory || current.dev !== record.dev || current.ino !== record.ino) {
          // Another directory occupies the path; custody was bound to the retired inode only.
          await releaseRetiredConnectedServiceHomeCustody(input.baseDir, record.path);
          return;
        }
        await input.revoke({ rootDir: record.path, agentId: record.agentId });
        await releaseRetiredConnectedServiceHomeCustody(input.baseDir, record.path);
      });
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}
