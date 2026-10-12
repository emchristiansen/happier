import { link } from 'node:fs/promises';

import { createAbsolutePathSymlink } from '@/utils/fs/createAbsolutePathSymlink';

import type { ConnectedServiceHomeEntryStat } from './connectedServiceHomeEntrySync';

function formatFsCode(error: unknown): string {
  const err = error as NodeJS.ErrnoException;
  return err?.code ? ` (${err.code})` : '';
}

function readFsCode(error: unknown): string | null {
  const err = error as NodeJS.ErrnoException;
  return typeof err?.code === 'string' && err.code.trim() ? err.code : null;
}

export class ConnectedServiceSharedStateLinkUnavailableError extends Error {
  readonly code = 'state_symlink_unavailable';
  readonly providerLabel: string;
  readonly entryName: string;
  readonly fsCode: string | null;

  constructor(params: Readonly<{
    providerLabel: string;
    entryName: string;
    symlinkError: unknown;
  }>) {
    super(
      `Cannot enable shared ${params.providerLabel} state for ${params.entryName}: symlink creation failed${formatFsCode(params.symlinkError)}.`,
    );
    this.name = 'ConnectedServiceSharedStateLinkUnavailableError';
    this.providerLabel = params.providerLabel;
    this.entryName = params.entryName;
    this.fsCode = readFsCode(params.symlinkError);
  }
}

export async function createConnectedServiceSharedStateLink(params: Readonly<{
  providerLabel: string;
  entryName: string;
  sourcePath: string;
  destinationPath: string;
  sourceStat: ConnectedServiceHomeEntryStat;
  allowHardLinkFallback: boolean;
}>): Promise<void> {
  try {
    await createAbsolutePathSymlink({
      sourcePath: params.sourcePath,
      destinationPath: params.destinationPath,
      sourceKind: params.sourceStat.isDirectory() ? 'directory' : 'file',
    });
    return;
  } catch (symlinkError) {
    if (!params.allowHardLinkFallback || params.sourceStat.isDirectory()) {
      throw new ConnectedServiceSharedStateLinkUnavailableError({
        providerLabel: params.providerLabel,
        entryName: params.entryName,
        symlinkError,
      });
    }
    try {
      await link(params.sourcePath, params.destinationPath);
      return;
    } catch (linkError) {
      throw new Error(
        `Cannot enable shared ${params.providerLabel} state for ${params.entryName}: symlink creation failed${formatFsCode(symlinkError)}; hard link fallback failed${formatFsCode(linkError)}.`,
      );
    }
  }
}
