import type { DirectSessionsSource, DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { createOpenCodeDirectClient } from './createOpenCodeDirectClient';
import { decodeOpenCodeDirectAfterCursor, encodeOpenCodeDirectAfterCursor } from './openCodeDirectAfterCursor';
import { mapOpenCodeMessageToDirectItem } from './mapOpenCodeMessageToDirectItem';
import { measureDirectTranscriptItemBytes } from './measureDirectTranscriptItemBytes';

import type { DirectSessionTranscriptReadAfter } from '@/backends/directSessions/providerOps';

export async function readAfterOpenCodeTranscript(params: Readonly<{
  source: DirectSessionsSource;
  remoteSessionId: string;
  cursor: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<DirectSessionTranscriptReadAfter> {
  const client = await createOpenCodeDirectClient(params.source);

  try {
    const rawMessages = await client.sessionMessagesList({ sessionId: params.remoteSessionId });
    const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
    const maxItems = Math.max(1, Math.trunc(params.maxItems));

    if (params.cursor === 'tail') {
      return {
        items: [],
        nextCursor: encodeOpenCodeDirectAfterCursor({ v: 1, kind: 'opencodeAfter', nextIndex: rawMessages.length }),
        truncated: false,
      };
    }

    const decoded = decodeOpenCodeDirectAfterCursor(params.cursor);
    if (!decoded) {
      return { items: [], nextCursor: null, truncated: true, truncationReason: 'source_discontinuity' };
    }

    if (decoded.nextIndex > rawMessages.length) {
      return {
        items: [],
        nextCursor: encodeOpenCodeDirectAfterCursor({ v: 1, kind: 'opencodeAfter', nextIndex: rawMessages.length }),
        truncated: true,
        truncationReason: 'source_discontinuity',
      };
    }

    const slice = rawMessages.slice(decoded.nextIndex);
    const items: DirectTranscriptRawMessageV1[] = [];
    let remainingBytes = maxBytes;
    let consumedCount = 0;
    let truncated = false;
    for (let i = 0; i < slice.length; i++) {
      const msg = mapOpenCodeMessageToDirectItem(slice[i], decoded.nextIndex + i);
      consumedCount += 1;
      if (!msg) continue;
      const itemBytes = measureDirectTranscriptItemBytes(msg);
      if (items.length >= maxItems) {
        consumedCount -= 1;
        truncated = true;
        break;
      }
      if (itemBytes > remainingBytes) {
        if (items.length === 0) {
          items.push(msg);
          remainingBytes = 0;
          continue;
        }
        consumedCount -= 1;
        truncated = true;
        break;
      }
      items.push(msg);
      remainingBytes -= itemBytes;
    }

    const nextIndex = decoded.nextIndex + consumedCount;
    const nextCursor = encodeOpenCodeDirectAfterCursor({ v: 1, kind: 'opencodeAfter', nextIndex });

    const hasMore = truncated || nextIndex < rawMessages.length;
    return {
      items,
      nextCursor,
      truncated: hasMore,
      ...(hasMore ? { truncationReason: 'page_limit' as const } : {}),
    };
  } finally {
    await client.dispose().catch(() => {});
  }
}
