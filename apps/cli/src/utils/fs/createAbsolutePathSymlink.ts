import { symlink } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function createAbsolutePathSymlink(params: Readonly<{
  sourcePath: string;
  destinationPath: string;
  sourceKind: 'file' | 'directory';
}>): Promise<void> {
  const type = process.platform === 'win32'
    ? params.sourceKind === 'directory' ? 'junction' : 'file'
    : params.sourceKind === 'directory' ? 'dir' : 'file';
  await symlink(resolve(params.sourcePath), params.destinationPath, type);
}
