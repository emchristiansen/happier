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
    if (hasBackup) {
      await rm(backupDir, { recursive: true, force: true });
    }
  } catch (error) {
    if (promoted) {
      await moveEntriesBetweenRootsBestEffort(carriedEntries, params.targetDir, backupDir);
      await rm(params.targetDir, { recursive: true, force: true }).catch(() => {});
    }
    if (hasBackup) {
      await rename(backupDir, params.targetDir).catch(() => {});
    }
    throw error;
  }
}
