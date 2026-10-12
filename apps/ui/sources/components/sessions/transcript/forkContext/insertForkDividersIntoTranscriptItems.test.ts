import { describe, expect, it } from 'vitest';

import { buildChatListItems, type ChatListItem } from '@/components/sessions/chatListItems';
import type { ForkedTranscriptSnapshot } from '@/sync/domains/sessionFork/forkedTranscriptSnapshot';
import { insertForkDividersIntoTranscriptItems } from './insertForkDividersIntoTranscriptItems';
import { buildForkAwareMessageDescriptors } from './buildForkAwareMessageDescriptors';
import { buildTranscriptTurnsCached } from '../turnGrouping/buildTranscriptTurns';

describe('insertForkDividersIntoTranscriptItems', () => {
  it('keeps a reached boundary when the complete row projection filters its first stored event', () => {
    const fork: ForkedTranscriptSnapshot = {
      segments: [
        { sessionId: 'parent', isReadOnlyContext: true, cutoffSeqInclusive: 0, isHistoryStartLoaded: true, messageIdsOldestFirst: [] },
        { sessionId: 'child', isReadOnlyContext: false, cutoffSeqInclusive: null, isHistoryStartLoaded: true, messageIdsOldestFirst: ['started', 'completed'] },
      ],
      combinedMessageIdsOldestFirst: ['started', 'completed'],
      combinedMessagesById: {
        started: { kind: 'agent-event', id: 'started', createdAt: 1, seq: 1, event: { type: 'context-compaction', phase: 'started', lifecycleId: 'compact', provider: 'codex' } },
        completed: { kind: 'agent-event', id: 'completed', createdAt: 2, seq: 2, event: { type: 'context-compaction', phase: 'completed', lifecycleId: 'compact', provider: 'codex' } },
      },
      messageOriginById: {}, isLoaded: true,
    };
    const items = buildChatListItems({
      messageIdsOldestFirst: fork.combinedMessageIdsOldestFirst.slice(),
      messagesById: fork.combinedMessagesById,
      pendingMessages: [],
    });
    expect(items.map((item) => item.id)).toEqual(['msg:completed']);
    expect(insertForkDividersIntoTranscriptItems({ items, fork, sourceWindowComplete: true }).map((item) => item.kind))
      .toEqual(['fork-divider', 'message']);
  });

  it('keeps parent and child turns separated when the first child event is filtered', () => {
    const fork: ForkedTranscriptSnapshot = {
      segments: [
        { sessionId: 'parent', isReadOnlyContext: true, cutoffSeqInclusive: 1, isHistoryStartLoaded: true, messageIdsOldestFirst: ['parent-row'] },
        { sessionId: 'child', isReadOnlyContext: false, cutoffSeqInclusive: null, isHistoryStartLoaded: true, messageIdsOldestFirst: ['started', 'completed'] },
      ],
      combinedMessageIdsOldestFirst: ['parent-row', 'started', 'completed'],
      combinedMessagesById: {
        'parent-row': { kind: 'agent-text', id: 'parent-row', localId: null, createdAt: 1, seq: 1, text: 'parent' },
        started: { kind: 'agent-event', id: 'started', createdAt: 2, seq: 1, event: { type: 'context-compaction', phase: 'started', lifecycleId: 'compact', provider: 'codex' } },
        completed: { kind: 'agent-event', id: 'completed', createdAt: 3, seq: 2, event: { type: 'context-compaction', phase: 'completed', lifecycleId: 'compact', provider: 'codex' } },
      },
      messageOriginById: {}, isLoaded: true,
    };
    const descriptors = buildForkAwareMessageDescriptors(fork);
    const cache = buildTranscriptTurnsCached({
      cache: null,
      messageIdsOldestFirst: descriptors.messageIdsOldestFirst.slice(),
      messagesById: descriptors.messagesById,
      forkBoundaryBeforeMessageIds: descriptors.forkBoundaryBeforeMessageIds,
      forkBoundarySignature: descriptors.forkBoundarySignature,
      groupToolCalls: false,
      toolCallsGroupStrategy: 'consecutive_tools',
    });
    const items = cache.turns.map((turn) => ({ kind: 'turn' as const, id: turn.id, turn }));
    expect(insertForkDividersIntoTranscriptItems({ items, fork, sourceWindowComplete: true }).map((item) => item.kind))
      .toEqual(['turn', 'fork-divider', 'turn']);
  });

  it('reveals only the boundaries reached while paging backward through a deep fork chain', () => {
    const project = (loadedSegmentIndexes: number[], renderedSegmentIndexes = loadedSegmentIndexes) => {
      const fork: ForkedTranscriptSnapshot = {
        segments: Array.from({ length: 11 }, (_, index) => ({
          sessionId: `session-${index}`,
          isReadOnlyContext: index < 10,
          cutoffSeqInclusive: index < 10 ? 500 : null,
          messageIdsOldestFirst: loadedSegmentIndexes.includes(index) ? [`message-${index}`] : [],
        })),
        combinedMessageIdsOldestFirst: loadedSegmentIndexes.map((index) => `message-${index}`),
        combinedMessagesById: {},
        messageOriginById: {},
        isLoaded: true,
      };
      const items: ChatListItem[] = renderedSegmentIndexes.map((index) => ({
        kind: 'message', id: `message-${index}`, messageId: `message-${index}`, createdAt: index, seq: 500,
      }));
      return insertForkDividersIntoTranscriptItems({ items, fork }).map((item) => item.id);
    };

    expect(project([10])).toEqual(['message-10']);
    expect(project([9, 10])).toEqual([
      'message-9', 'fork-divider:session-9:session-10', 'message-10',
    ]);
    expect(project([8, 9, 10])).toEqual([
      'message-8', 'fork-divider:session-8:session-9', 'message-9',
      'fork-divider:session-9:session-10', 'message-10',
    ]);

    // The turn projection initially derives only a tail window, even when earlier
    // segments are already cached. Cached ancestry does not put its seams in that window.
    expect(project([8, 9, 10], [10])).toEqual(['message-10']);
  });

  it('does not publish ancestry dividers for pending rows without loaded source content', () => {
    const items: ChatListItem[] = [{
      kind: 'pending-queue', id: 'pending-queue', pendingMessages: [], discardedMessages: [],
    }];
    const fork: ForkedTranscriptSnapshot = {
      segments: [
        { sessionId: 'parent', isReadOnlyContext: true, cutoffSeqInclusive: 20, messageIdsOldestFirst: [] },
        { sessionId: 'child', isReadOnlyContext: false, cutoffSeqInclusive: null, messageIdsOldestFirst: [] },
      ],
      combinedMessageIdsOldestFirst: [], combinedMessagesById: {}, messageOriginById: {}, isLoaded: true,
    };

    expect(insertForkDividersIntoTranscriptItems({ items, fork })).toEqual(items);
  });

  it('keeps reached leading boundaries through known empty segments, but not an unloaded segment', () => {
    const items: ChatListItem[] = [
      { kind: 'message', id: 'msg:c1', messageId: 'c1', createdAt: 1, seq: 1 },
    ];
    const fork: ForkedTranscriptSnapshot = {
      segments: [
        { sessionId: 'root', isReadOnlyContext: true, cutoffSeqInclusive: 100, messageIdsOldestFirst: [] },
        { sessionId: 'unloaded', isReadOnlyContext: true, cutoffSeqInclusive: 50, messageIdsOldestFirst: [] },
        { sessionId: 'empty', isReadOnlyContext: true, cutoffSeqInclusive: 0, messageIdsOldestFirst: [] },
        { sessionId: 'child', isReadOnlyContext: false, cutoffSeqInclusive: null, isHistoryStartLoaded: true, messageIdsOldestFirst: ['c1'] },
      ],
      combinedMessageIdsOldestFirst: ['c1'],
      combinedMessagesById: {
        c1: { kind: 'agent-text', id: 'c1', localId: null, createdAt: 1, seq: 1, text: 'child' },
      },
      messageOriginById: {}, isLoaded: true,
    };

    expect(insertForkDividersIntoTranscriptItems({ items, fork }).map((item) => item.id)).toEqual([
      'fork-divider:unloaded:empty', 'fork-divider:empty:child', 'msg:c1',
    ]);
  });

  it('does not move a cached child-start boundary to the first row of a truncated turn window', () => {
    const items: ChatListItem[] = [
      { kind: 'message', id: 'msg:c100', messageId: 'c100', createdAt: 100, seq: 100 },
    ];
    const fork: ForkedTranscriptSnapshot = {
      segments: [
        { sessionId: 'parent', isReadOnlyContext: true, cutoffSeqInclusive: 100, messageIdsOldestFirst: [] },
        { sessionId: 'child', isReadOnlyContext: false, cutoffSeqInclusive: null, isHistoryStartLoaded: true, messageIdsOldestFirst: ['c1', 'c100'] },
      ],
      combinedMessageIdsOldestFirst: ['c1', 'c100'],
      combinedMessagesById: {
        c1: { kind: 'agent-text', id: 'c1', localId: null, createdAt: 1, seq: 1, text: 'start' },
        c100: { kind: 'agent-text', id: 'c100', localId: null, createdAt: 100, seq: 100, text: 'tail' },
      },
      messageOriginById: {}, isLoaded: true,
    };

    expect(insertForkDividersIntoTranscriptItems({ items, fork }).map((item) => item.id)).toEqual(['msg:c100']);
  });

  it('inserts fork dividers between grouped tool rows using source message ids', () => {
    const base: ChatListItem[] = [
      { kind: 'tool-calls-group', id: 'toolCalls:linear:p-tool', toolMessageIds: ['p-tool'], createdAt: 1 },
      { kind: 'tool-calls-group', id: 'toolCalls:linear:c-tool', toolMessageIds: ['c-tool'], createdAt: 2 },
    ];

    const fork: ForkedTranscriptSnapshot = {
      segments: [
        { sessionId: 'parent', isReadOnlyContext: true, cutoffSeqInclusive: 2, messageIdsOldestFirst: ['p-tool'] },
        { sessionId: 'child', isReadOnlyContext: false, cutoffSeqInclusive: null, messageIdsOldestFirst: ['c-tool'] },
      ],
      combinedMessageIdsOldestFirst: ['p-tool', 'c-tool'],
      combinedMessagesById: {} as any,
      messageOriginById: {
        'p-tool': { sessionId: 'parent', isReadOnlyContext: true },
        'c-tool': { sessionId: 'child', isReadOnlyContext: false },
      },
      isLoaded: true,
    };

    const result = insertForkDividersIntoTranscriptItems({ items: base, fork });
    expect(result.map((i) => i.kind)).toEqual(['tool-calls-group', 'fork-divider', 'tool-calls-group']);
    expect(result[1]).toMatchObject({
      kind: 'fork-divider',
      parentSessionId: 'parent',
      childSessionId: 'child',
    });
  });

  it('inserts fork dividers between segments and marks ancestor messages read-only', () => {
    const base: ChatListItem[] = [
      { kind: 'message', id: 'msg:p1', messageId: 'p1', createdAt: 1, seq: 1 },
      { kind: 'message', id: 'msg:p2', messageId: 'p2', createdAt: 2, seq: 2 },
      { kind: 'message', id: 'msg:c1', messageId: 'c1', createdAt: 3, seq: 1 },
      { kind: 'pending-queue', id: 'pending-queue', pendingMessages: [{ id: 'p1', localId: 'x', createdAt: 9, updatedAt: 9, text: 'pending', rawRecord: {} }], discardedMessages: [] },
    ];

    const fork: ForkedTranscriptSnapshot = {
      segments: [
        { sessionId: 'parent', isReadOnlyContext: true, cutoffSeqInclusive: 2, messageIdsOldestFirst: ['p1', 'p2'] },
        { sessionId: 'child', isReadOnlyContext: false, cutoffSeqInclusive: null, messageIdsOldestFirst: ['c1'] },
      ],
      combinedMessageIdsOldestFirst: ['p1', 'p2', 'c1'],
      combinedMessagesById: {} as any,
      messageOriginById: {
        p1: { sessionId: 'parent', isReadOnlyContext: true },
        p2: { sessionId: 'parent', isReadOnlyContext: true },
        c1: { sessionId: 'child', isReadOnlyContext: false },
      },
      isLoaded: true,
    };

    const result = insertForkDividersIntoTranscriptItems({ items: base, fork });
    expect(result.map((i) => i.kind)).toEqual(['message', 'message', 'fork-divider', 'message', 'pending-queue']);
    const divider = result[2] as Extract<ChatListItem, { kind: 'fork-divider' }>;
    expect(divider).toMatchObject({
      kind: 'fork-divider',
      parentSessionId: 'parent',
      childSessionId: 'child',
      parentCutoffSeqInclusive: 2,
    });
    const p1 = result[0] as Extract<ChatListItem, { kind: 'message' }>;
    expect(p1.originSessionId).toBe('parent');
    expect(p1.isReadOnlyContext).toBe(true);
  });

  it('inserts a fork divider even when the child segment is empty', () => {
    const base: ChatListItem[] = [
      { kind: 'message', id: 'msg:p1', messageId: 'p1', createdAt: 1, seq: 1 },
      { kind: 'message', id: 'msg:p2', messageId: 'p2', createdAt: 2, seq: 2 },
    ];

    const fork: ForkedTranscriptSnapshot = {
      segments: [
        { sessionId: 'parent', isReadOnlyContext: true, cutoffSeqInclusive: 2, messageIdsOldestFirst: ['p1', 'p2'] },
        { sessionId: 'child', isReadOnlyContext: false, cutoffSeqInclusive: null, messageIdsOldestFirst: [] },
      ],
      combinedMessageIdsOldestFirst: ['p1', 'p2'],
      combinedMessagesById: {} as any,
      messageOriginById: {
        p1: { sessionId: 'parent', isReadOnlyContext: true },
        p2: { sessionId: 'parent', isReadOnlyContext: true },
      },
      isLoaded: true,
    };

    const result = insertForkDividersIntoTranscriptItems({ items: base, fork });
    expect(result.map((i) => i.kind)).toEqual(['message', 'message', 'fork-divider']);
    const divider = result[2] as Extract<ChatListItem, { kind: 'fork-divider' }>;
    expect(divider).toMatchObject({
      kind: 'fork-divider',
      parentSessionId: 'parent',
      childSessionId: 'child',
      parentCutoffSeqInclusive: 2,
    });
  });

  it('uses boundary-stable ids for multi-level fork chains', () => {
    const base: ChatListItem[] = [
      { kind: 'message', id: 'msg:a1', messageId: 'a1', createdAt: 1, seq: 1 },
      { kind: 'message', id: 'msg:a2', messageId: 'a2', createdAt: 2, seq: 2 },
      { kind: 'message', id: 'msg:b1', messageId: 'b1', createdAt: 3, seq: 1 },
    ];

    const fork: ForkedTranscriptSnapshot = {
      segments: [
        { sessionId: 'A', isReadOnlyContext: true, cutoffSeqInclusive: 2, messageIdsOldestFirst: ['a1', 'a2'] },
        { sessionId: 'B', isReadOnlyContext: true, cutoffSeqInclusive: 1, messageIdsOldestFirst: ['b1'] },
        { sessionId: 'C', isReadOnlyContext: false, cutoffSeqInclusive: null, messageIdsOldestFirst: [] },
      ],
      combinedMessageIdsOldestFirst: ['a1', 'a2', 'b1'],
      combinedMessagesById: {} as any,
      messageOriginById: {
        a1: { sessionId: 'A', isReadOnlyContext: true },
        a2: { sessionId: 'A', isReadOnlyContext: true },
        b1: { sessionId: 'B', isReadOnlyContext: true },
      },
      isLoaded: true,
    };

    const result = insertForkDividersIntoTranscriptItems({ items: base, fork });
    expect(result.map((i) => i.kind)).toEqual(['message', 'message', 'fork-divider', 'message', 'fork-divider']);
    const first = result[2] as Extract<ChatListItem, { kind: 'fork-divider' }>;
    const second = result[4] as Extract<ChatListItem, { kind: 'fork-divider' }>;
    expect(first).toMatchObject({ parentSessionId: 'A', childSessionId: 'B', id: 'fork-divider:A:B' });
    expect(second).toMatchObject({ parentSessionId: 'B', childSessionId: 'C', id: 'fork-divider:B:C' });
  });

  it('places empty intermediate segment dividers before the next non-empty descendant segment', () => {
    const base: ChatListItem[] = [
      { kind: 'message', id: 'msg:a1', messageId: 'a1', createdAt: 1, seq: 1 },
      { kind: 'message', id: 'msg:c1', messageId: 'c1', createdAt: 2, seq: 1 },
    ];

    const fork: ForkedTranscriptSnapshot = {
      segments: [
        { sessionId: 'A', isReadOnlyContext: true, cutoffSeqInclusive: 1, messageIdsOldestFirst: ['a1'] },
        { sessionId: 'B', isReadOnlyContext: true, cutoffSeqInclusive: 0, messageIdsOldestFirst: [] },
        { sessionId: 'C', isReadOnlyContext: false, cutoffSeqInclusive: null, messageIdsOldestFirst: ['c1'] },
      ],
      combinedMessageIdsOldestFirst: ['a1', 'c1'],
      combinedMessagesById: {} as any,
      messageOriginById: {
        a1: { sessionId: 'A', isReadOnlyContext: true },
        c1: { sessionId: 'C', isReadOnlyContext: false },
      },
      isLoaded: true,
    };

    const result = insertForkDividersIntoTranscriptItems({ items: base, fork });
    expect(result.map((i) => i.kind)).toEqual(['message', 'fork-divider', 'fork-divider', 'message']);
    expect(result[1]).toMatchObject({ kind: 'fork-divider', parentSessionId: 'A', childSessionId: 'B' });
    expect(result[2]).toMatchObject({ kind: 'fork-divider', parentSessionId: 'B', childSessionId: 'C' });
  });

  it('places trailing empty child dividers before non-source child rows', () => {
    const base: ChatListItem[] = [
      { kind: 'message', id: 'msg:p1', messageId: 'p1', createdAt: 1, seq: 1 },
      { kind: 'pending-queue', id: 'pending-queue', pendingMessages: [{ id: 'pending', localId: 'local', createdAt: 2, updatedAt: 2, text: 'pending', rawRecord: {} }], discardedMessages: [] },
    ];

    const fork: ForkedTranscriptSnapshot = {
      segments: [
        { sessionId: 'parent', isReadOnlyContext: true, cutoffSeqInclusive: 1, messageIdsOldestFirst: ['p1'] },
        { sessionId: 'child', isReadOnlyContext: false, cutoffSeqInclusive: null, messageIdsOldestFirst: [] },
      ],
      combinedMessageIdsOldestFirst: ['p1'],
      combinedMessagesById: {} as any,
      messageOriginById: {
        p1: { sessionId: 'parent', isReadOnlyContext: true },
      },
      isLoaded: true,
    };

    const result = insertForkDividersIntoTranscriptItems({ items: base, fork });
    expect(result.map((i) => i.kind)).toEqual(['message', 'fork-divider', 'pending-queue']);
  });
});
