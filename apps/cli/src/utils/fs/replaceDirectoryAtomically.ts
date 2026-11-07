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
  /**
   * Records durable custody of a sibling that this replacement may retain, before anything moves:
   * `identity` is the directory that would be renamed to `retired` (the current target for the
   * `.previous-*` home, the staged directory for the `.rejected-*` home). A failed claim aborts the
   * replacement before any rename, so a retained sibling never exists without durable custody.
   */
  claimRetiredDirectory?: (claim: Readonly<{ retired: string; canonical: string; identity: string }>) => Promise<void>;
  /** Ends a claim whose sibling was never created. An obsolete claim never revokes anything. */
  releaseRetiredDirectoryClaim?: (retired: string) => Promise<void>;
  writeArtifacts?: <T>(write: () => Promise<T>) => Promise<T>;
}>): Promise<void> {
  const writeArtifacts = params.writeArtifacts ?? (async <T>(write: () => Promise<T>) => await write());
  await writeArtifacts(() => mkdir(dirname(params.targetDir), { recursive: true }));
  const backupDir = `${params.targetDir}.previous-${randomUUID()}`;
  const rejectedDir = `${params.targetDir}.rejected-${randomUUID()}`;
  let hasBackup = false;
  let promoted = false;
  let carriedEntries: string[] = [];
  try {
    await writeArtifacts(async () => {
      if (params.retireDirectory) {
        await params.claimRetiredDirectory?.({ retired: backupDir, canonical: params.targetDir, identity: params.targetDir });
        await params.claimRetiredDirectory?.({ retired: rejectedDir, canonical: params.targetDir, identity: params.stagedDir });
      }
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
    if (hasBackup && !params.retireDirectory) {
      await rm(backupDir, { recursive: true, force: true });
    }
  } catch (error) {
    let rejected = false;
    if (promoted) {
      await moveEntriesBetweenRootsBestEffort(carriedEntries, params.targetDir, backupDir);
      if (params.retireDirectory) {
        // Restore the old canonical home without deleting the rejected transcript bytes; the
        // rejected sibling's custody was claimed before promotion.
        await rename(params.targetDir, rejectedDir);
        rejected = true;
      } else {
        await rm(params.targetDir, { recursive: true, force: true }).catch(() => {});
      }
    }
    if (hasBackup) {
      if (params.retireDirectory) await rename(backupDir, params.targetDir);
      else await rename(backupDir, params.targetDir).catch(() => {});
    }
    if (!promoted && params.retireDirectory) {
      // Without a promotion the rejected sibling can never be created; end its claim as on success.
      await params.releaseRetiredDirectoryClaim?.(rejectedDir).catch(() => {});
    }
    if (rejected && params.retireDirectory) {
      try { await params.retireDirectory(rejectedDir); }
      catch (retirementError) {
        throw new AggregateError(
          [error, retirementError],
          'Promotion failed and credential retirement failed; both homes were retained',
        );
      }
    }
    throw error;
  }
  if (params.retireDirectory) {
    // The rejected sibling was never created. Releasing its claim is tidiness only: an obsolete
    // claim cannot revoke the live home, so its failure must not fail a valid promotion.
    await params.releaseRetiredDirectoryClaim?.(rejectedDir).catch(() => {});
  }
  // A retirement failure must not roll back a valid promotion or fall through to recursive rm.
  if (hasBackup && params.retireDirectory) {
    await params.retireDirectory(backupDir);
  }
}
