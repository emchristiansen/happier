import type { DirectSessionsSource, DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { readJsonlFileForward } from '@/api/directSessions/filePaging/jsonlForwardReader';

import { decodeClaudeDirectForwardCursor, encodeClaudeDirectForwardCursor, readClaudeDirectTailCursor } from './claudeDirectForwardCursor';
import { mapClaudeJsonlLineToDirectMessages } from './mapClaudeJsonlLineToDirectMessages';
import { resolveClaudeDirectSessionFile } from './resolveClaudeDirectSessionFile';

import type { DirectSessionTranscriptReadAfter } from '@/backends/directSessions/providerOps';

export async function readAfterClaudeTranscript(params: Readonly<{
  source: DirectSessionsSource;
  env?: NodeJS.ProcessEnv;
  remoteSessionId: string;
  cursor: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<DirectSessionTranscriptReadAfter> {
  const env = params.env ?? process.env;
  const resolved = await resolveClaudeDirectSessionFile({
    source: params.source,
    env,
    remoteSessionId: params.remoteSessionId,
  });
  if (!resolved) {
    return { items: [], nextCursor: null, truncated: false };
  }

  const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
  const maxItems = Math.max(1, Math.trunc(params.maxItems));

  if (params.cursor === 'tail') {
    return {
      items: [],
      nextCursor: await readClaudeDirectTailCursor({ ...resolved, maxBytes }),
      truncated: false,
    };
  }

  const decoded = decodeClaudeDirectForwardCursor(params.cursor);
  if (!decoded) {
    return { items: [], nextCursor: null, truncated: true, truncationReason: 'source_discontinuity' };
  }

  if (decoded.fileRelPath !== resolved.fileRelPath) {
    return {
      items: [],
      nextCursor: await readClaudeDirectTailCursor({ ...resolved, maxBytes }),
      truncated: true,
      truncationReason: 'source_discontinuity',
    };
  }

  const offsetBytes = Math.max(0, decoded.offsetBytes);
  const read = await readJsonlFileForward({
    filePath: resolved.filePath,
    offsetBytes,
    maxBytes,
    maxItems,
  });

  if (read.truncated) {
    return {
      items: [],
      nextCursor: await readClaudeDirectTailCursor({ ...resolved, maxBytes }),
      truncated: true,
      truncationReason: 'source_discontinuity',
    };
  }

  const items: DirectTranscriptRawMessageV1[] = [];
  for (const line of read.items) {
    if (items.length >= maxItems) break;
    const mapped = mapClaudeJsonlLineToDirectMessages({
      fileRelPath: resolved.fileRelPath,
      lineStartOffsetBytes: line.startOffsetBytes,
      lineValue: line.value,
    });
    for (const msg of mapped) {
      if (items.length >= maxItems) break;
      items.push(msg);
    }
  }

  return {
    items,
    nextCursor: encodeClaudeDirectForwardCursor({ v: 1, kind: 'claudeForward', fileRelPath: resolved.fileRelPath, offsetBytes: read.nextOffsetBytes }),
    truncated: false,
    ...(read.hitPageLimit ? { truncationReason: 'page_limit' as const } : {}),
  };
}
