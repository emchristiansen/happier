import { lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** Remove provider-declared credentials without traversing linked homes or touching history. */
export async function removeConnectedServiceCredentialFiles(
  rootDir: string,
  entries: readonly string[],
): Promise<void> {
  for (const entry of entries) {
    const segments = entry.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\\'))) {
      throw new Error(`Invalid connected-service credential entry: ${entry}`);
    }
    let parent = rootDir;
    let owned = true;
    for (const segment of ['', ...segments.slice(0, -1)]) {
      parent = segment ? join(parent, segment) : parent;
      try {
        const info = await lstat(parent);
        if (!info.isDirectory() || info.isSymbolicLink()) { owned = false; break; }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        owned = false;
        break;
      }
    }
    if (owned) {
      // The provider declares a credential filename, not ownership of an arbitrary subtree.
      // unlink refuses directories even if the leaf changes after the parent checks. This also
      // leaves an unqualified legacy accounts directory intact and reports cleanup failure.
      try { await unlink(join(rootDir, ...segments)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}
