import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type PreservedDirectoryEntries = Readonly<{
  root: string;
  exclude?: readonly string[];
}>;

async function moveEntryMergingBestEffort(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    await rename(sourcePath, destinationPath);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'EISDIR') return;
  }
  let childNames: string[];
  try { childNames = await readdir(sourcePath); } catch { return; }
  for (const childName of childNames) {
    await moveEntryMergingBestEffort(join(sourcePath, childName), join(destinationPath, childName));
  }
}

async function listEntryNamesBestEffort(directoryPath: string): Promise<string[]> {
  try { return await readdir(directoryPath); } catch { return []; }
}

async function snapshotUnprovidedEntrySpecs(specs: readonly PreservedDirectoryEntries[], stagedDir: string) {
  const snapshots = [];
  for (const spec of specs) {
    const provided = await listEntryNamesBestEffort(join(stagedDir, spec.root));
    snapshots.push({ root: spec.root, skip: new Set([...(spec.exclude ?? []), ...provided]) });
  }
  return snapshots;
}

async function moveEntriesBetweenRootsBestEffort(entries: readonly string[], fromRoot: string, toRoot: string): Promise<void> {
  for (const entry of entries) {
    const destinationPath = join(toRoot, entry);
    await mkdir(dirname(destinationPath), { recursive: true }).catch(() => {});
    await moveEntryMergingBestEffort(join(fromRoot, entry), destinationPath);
  }
}

async function carryUnprovidedEntriesBestEffort(
  snapshots: Awaited<ReturnType<typeof snapshotUnprovidedEntrySpecs>>, fromRoot: string, toRoot: string,
): Promise<string[]> {
  const carried: string[] = [];
  for (const snapshot of snapshots) {
    for (const name of await listEntryNamesBestEffort(join(fromRoot, snapshot.root))) {
      if (!snapshot.skip.has(name)) carried.push(join(snapshot.root, name));
    }
  }
  // Rename preserves process-held lock identities. Merge only runtime entries recreated after the snapshot.
  await moveEntriesBetweenRootsBestEffort(carried, fromRoot, toRoot);
  return carried;
}

export async function replaceDirectoryAtomically(params: Readonly<{
  stagedDir: string;
  targetDir: string;
  preserveUnprovidedEntries?: readonly PreservedDirectoryEntries[];
  afterPromote?: () => Promise<void> | void;
  /** Connected-service callers revoke credentials and retain the retired home's history. */
  retireDirectory?: (directory: string) => Promise<void>;
  writeArtifacts?: <T>(write: () => Promise<T>) => Promise<T>;
}>): Promise<void> {
  const writeArtifacts = params.writeArtifacts ?? (async <T>(write: () => Promise<T>) => await write());
  await writeArtifacts(() => mkdir(dirname(params.targetDir), { recursive: true }));
  const backupDir = `${params.targetDir}.previous-${randomUUID()}`;
  let hasBackup = false;
  let promoted = false;
  let carriedEntries: string[] = [];
  try {
    await writeArtifacts(async () => {
      try {
        await rename(params.targetDir, backupDir);
        hasBackup = true;
      } catch {
        hasBackup = false;
      }
    });
    const snapshots = await snapshotUnprovidedEntrySpecs(params.preserveUnprovidedEntries ?? [], params.stagedDir);
    await writeArtifacts(async () => {
      await rename(params.stagedDir, params.targetDir);
      promoted = true;
      if (hasBackup) carriedEntries = await carryUnprovidedEntriesBestEffort(snapshots, backupDir, params.targetDir);
    });
    await params.afterPromote?.();
  } catch (error) {
    let rejectedDir: string | undefined;
    if (promoted) {
      await moveEntriesBetweenRootsBestEffort(carriedEntries, params.targetDir, backupDir);
      if (params.retireDirectory) {
        // Restore the old canonical home without deleting the rejected transcript bytes.
        rejectedDir = `${params.targetDir}.rejected-${randomUUID()}`;
        await rename(params.targetDir, rejectedDir);
      } else {
        await rm(params.targetDir, { recursive: true, force: true }).catch(() => {});
      }
    }
    if (hasBackup) {
      if (params.retireDirectory) await rename(backupDir, params.targetDir);
      else await rename(backupDir, params.targetDir).catch(() => {});
    }
    if (rejectedDir && params.retireDirectory) {
      try { await params.retireDirectory(rejectedDir); }
      catch (retirementError) {
        throw new AggregateError([error, retirementError], 'Promotion failed and credential retirement failed; both homes were retained');
      }
    }
    throw error;
  }
  // A retirement failure must not roll back a valid promotion or fall through to recursive rm.
  if (hasBackup) {
    if (params.retireDirectory) await params.retireDirectory(backupDir);
    else await rm(backupDir, { recursive: true, force: true });
  }
}
