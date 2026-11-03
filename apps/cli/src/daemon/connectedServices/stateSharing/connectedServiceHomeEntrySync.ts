import { copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createAbsolutePathSymlink } from '@/utils/fs/createAbsolutePathSymlink';

export type ConnectedServiceHomeEntryStat = Awaited<ReturnType<typeof stat>>;

export async function tryLstatConnectedServiceHomeEntry(path: string): Promise<ConnectedServiceHomeEntryStat | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function tryStatConnectedServiceHomeEntry(path: string): Promise<ConnectedServiceHomeEntryStat | null> {
  try {
    return await stat(path);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function removeLinkedConnectedServiceHomeEntries(
  destinationHome: string,
  entryNames: readonly string[],
): Promise<void> {
  for (const entryName of entryNames) {
    const destinationPath = join(destinationHome, entryName);
    let destinationStat;
    try {
      destinationStat = await lstat(destinationPath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === 'ENOENT') continue;
      throw error;
    }
    if (destinationStat.isSymbolicLink()) {
      await rm(destinationPath, { recursive: true, force: true });
    }
  }
}

export async function moveConnectedServiceHomeEntryAside(path: string): Promise<string | null> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = `.local-${Date.now()}${attempt === 0 ? '' : `-${attempt}`}`;
    try {
      const destination = `${path}${suffix}`;
      const info = await lstat(path);
      if (!info.isDirectory()) {
        // rename replaces an existing file on POSIX. An exclusive link retains every collision.
        await link(path, destination);
        await unlink(path);
      } else {
        await rename(path, destination);
      }
      return destination;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === 'ENOENT') return null;
      // A same-timestamp sibling collision can report EEXIST, ENOTEMPTY, or EISDIR
      // depending on whether the existing backup is a file or directory and the host OS.
      if (err?.code === 'EEXIST' || err?.code === 'ENOTEMPTY' || err?.code === 'EISDIR') continue;
      throw error;
    }
  }
  throw new Error(`Unable to migrate existing connected-service home entry aside for ${path}`);
}

export async function prepareManagedConnectedServiceHomeDestination(destinationPath: string): Promise<void> {
  let destinationStat;
  try {
    destinationStat = await lstat(destinationPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return;
    throw error;
  }
  if (destinationStat.isSymbolicLink()) {
    await rm(destinationPath, { recursive: true, force: true });
    return;
  }
  await moveConnectedServiceHomeEntryAside(destinationPath);
}

export async function isConnectedServiceHomeEntryLinkedToSource(
  sourcePath: string,
  destinationPath: string,
): Promise<boolean> {
  try {
    const destinationStat = await lstat(destinationPath);
    if (destinationStat.isSymbolicLink()) {
      const [sourceRealPath, destinationRealPath] = await Promise.all([realpath(sourcePath), realpath(destinationPath)]);
      return sourceRealPath === destinationRealPath;
    }
    if (!destinationStat.isFile()) return false;
    const sourceStat = await stat(sourcePath);
    return sourceStat.isFile() && sourceStat.ino !== 0
      && sourceStat.ino === destinationStat.ino && sourceStat.dev === destinationStat.dev;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function copyConnectedServiceHomeEntry(
  sourcePath: string,
  destinationPath: string,
  options?: Readonly<{ removeMissingDestinationEntries?: boolean }>,
): Promise<void> {
  const sourceStat = await tryStatConnectedServiceHomeEntry(sourcePath);
  if (!sourceStat) {
    // Includes dangling source symlinks. Only copied configuration owns removal of stale copies.
    if (options?.removeMissingDestinationEntries) await rm(destinationPath, { recursive: true, force: true });
    return;
  }
  let destinationStat = await tryLstatConnectedServiceHomeEntry(destinationPath);
  if (destinationStat && (destinationStat.isSymbolicLink() || destinationStat.isDirectory() !== sourceStat.isDirectory())) {
    await prepareManagedConnectedServiceHomeDestination(destinationPath);
    destinationStat = null;
  }

  if (sourceStat.isDirectory()) {
    await mkdir(destinationPath, { recursive: true, mode: Number(sourceStat.mode) });
    const sourceEntries = await readdir(sourcePath);
    if (options?.removeMissingDestinationEntries) {
      const sourceNames = new Set(sourceEntries);
      for (const destinationName of await readdir(destinationPath)) {
        if (!sourceNames.has(destinationName)) await rm(join(destinationPath, destinationName), { recursive: true, force: true });
      }
    }
    for (const entryName of sourceEntries) {
      await copyConnectedServiceHomeEntry(join(sourcePath, entryName), join(destinationPath, entryName), options);
    }
    return;
  }
  if (destinationStat?.isFile() && destinationStat.size === sourceStat.size) {
    const [sourceContent, destinationContent] = await Promise.all([readFile(sourcePath), readFile(destinationPath)]);
    if (sourceContent.equals(destinationContent)) return;
  }
  await mkdir(dirname(destinationPath), { recursive: true });
  await copyFile(sourcePath, destinationPath);
}

export async function linkConnectedServiceHomeEntry(
  sourcePath: string,
  destinationPath: string,
  sourceStat: ConnectedServiceHomeEntryStat,
  options?: Readonly<{ replaceManagedDestination?: boolean }>,
): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true });
  if (options?.replaceManagedDestination) {
    const scratchRoot = await mkdtemp(`${destinationPath}.happier-config-link-`);
    try {
      const preparedLink = join(scratchRoot, 'entry');
      await createAbsolutePathSymlink({
        sourcePath, destinationPath: preparedLink,
        sourceKind: sourceStat.isDirectory() ? 'directory' : 'file',
      });
      // Only a manifest-owned projection reaches this path. Establish link support before
      // removing it, so copy fallback can refresh the same file/directory without backup churn.
      await rm(destinationPath, { recursive: true, force: true });
      await rename(preparedLink, destinationPath);
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
    return;
  }
  await createAbsolutePathSymlink({
    sourcePath,
    destinationPath,
    sourceKind: sourceStat.isDirectory() ? 'directory' : 'file',
  });
}
