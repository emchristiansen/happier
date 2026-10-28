import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/configuration', () => ({
  configuration: { serverUrl: 'http://example.test', apiServerUrl: 'http://example.test' },
}));

vi.mock('../client/loopbackUrl', () => ({
  resolveLoopbackHttpUrl: (url: string) => url,
}));

import axios from 'axios';

import { HttpStatusError } from '@/api/client/httpStatusError';
import type { Update } from '../types';

import { catchUpSessionMessagesAfterSeq, readSessionHistoryReplayProvenance } from './sessionMessageCatchUp';
import { handleSessionNewMessageUpdate } from './sessionNewMessageUpdate';

describe('sessionMessageCatchUp (plaintext envelopes)', () => {
  afterEach(() => vi.restoreAllMocks());

  const createMessage = (seq: number) => ({
    id: `m${seq}`,
    seq,
    createdAt: seq * 100,
    updatedAt: seq * 100 + 1,
    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `message ${seq}` } } },
  });

  it('continues beyond a full page when the server cursor equals its last message sequence', async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => createMessage(index + 1));
    const getSpy = vi.spyOn(axios, 'get')
      .mockResolvedValueOnce({
        data: { messages: firstPage, hasMore: true, nextBeforeSeq: null, nextAfterSeq: 200 },
      })
      .mockResolvedValueOnce({
        data: { messages: [createMessage(201)], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null },
      });
    const updates: Update[] = [];

    await catchUpSessionMessagesAfterSeq({
      token: 't',
      sessionId: 's1',
      afterSeq: 0,
      onUpdate: (update) => updates.push(update),
    });

    expect(updates.map((update) => update.body.t === 'new-message' ? update.body.message.seq : null))
      .toEqual(Array.from({ length: 201 }, (_, index) => index + 1));
    expect(getSpy).toHaveBeenNthCalledWith(2, expect.any(String), expect.objectContaining({
      params: { afterSeq: 200, limit: 200 },
    }));
    expect(readSessionHistoryReplayProvenance(updates[200]!)).toEqual({
      sourceCreatedAt: 20_100,
      sourceUpdatedAt: 20_101,
    });
  });

  it('continues until an advancing server cursor exhausts backlogs larger than ten pages', async () => {
    const allMessages = Array.from({ length: 2_201 }, (_, index) => createMessage(index + 1));
    const getSpy = vi.spyOn(axios, 'get').mockImplementation(async (_url, config) => {
      const afterSeq = Number(config?.params?.afterSeq ?? 0);
      const messages = allMessages.filter((message) => message.seq > afterSeq).slice(0, 200);
      const lastSeq = messages.at(-1)?.seq ?? afterSeq;
      return {
        data: {
          messages,
          hasMore: lastSeq < allMessages.length,
          nextBeforeSeq: null,
          nextAfterSeq: lastSeq < allMessages.length ? lastSeq : null,
        },
      };
    });
    const updates: Update[] = [];

    await catchUpSessionMessagesAfterSeq({
      token: 't',
      sessionId: 's1',
      afterSeq: 0,
      onUpdate: (update) => updates.push(update),
    });

    expect(getSpy).toHaveBeenCalledTimes(12);
    expect(updates).toHaveLength(2_201);
    expect(updates.at(-1)?.body).toMatchObject({ t: 'new-message', message: { seq: 2_201 } });
  });

  it.each([9, 10])('stops when the returned cursor %s does not advance the requested cursor', async (nextAfterSeq) => {
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: { messages: [createMessage(11)], hasMore: true, nextBeforeSeq: null, nextAfterSeq },
    });
    const updates: Update[] = [];

    await catchUpSessionMessagesAfterSeq({
      token: 't',
      sessionId: 's1',
      afterSeq: 10,
      onUpdate: (update) => updates.push(update),
    });

    expect(updates.map((update) => update.body.t === 'new-message' ? update.body.message.seq : null)).toEqual([11]);
  });

  it('emits new-message updates for plaintext transcript messages', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            id: 'm1',
            seq: 12,
            localId: ' l1 ',
            sidechainId: ' sc-1 ',
            createdAt: 123,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
          },
        ],
      },
    } as any);

    const updates: any[] = [];
    await catchUpSessionMessagesAfterSeq({
      token: 't',
      sessionId: 's1',
      afterSeq: 10,
      onUpdate: (u) => updates.push(u),
    });

    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(getSpy).toHaveBeenCalledWith(
      expect.stringContaining('/v1/sessions/s1/messages'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer t',
        }),
      }),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.body?.t).toBe('new-message');
    expect(updates[0]?.body?.message?.content?.t).toBe('plain');
    expect(updates[0]?.body?.message?.localId).toBe(' l1 ');
    expect(updates[0]?.body?.message?.sidechainId).toBe(' sc-1 ');
    expect(updates[0]?.body?.message?.createdAt).toBe(123);
    expect(updates[0]?.body?.message?.updatedAt).toBe(123);
  });

  it('preserves missing transcript timestamps as unavailable in catch-up updates', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            id: 'm1',
            seq: 12,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
          },
        ],
      },
    } as any);

    const updates: any[] = [];
    await catchUpSessionMessagesAfterSeq({
      token: 't',
      sessionId: 's1',
      afterSeq: 10,
      onUpdate: (u) => updates.push(u),
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]?.createdAt).toBeNull();
    expect(updates[0]?.body?.message?.createdAt).toBeNull();
    expect(updates[0]?.body?.message?.updatedAt).toBeNull();
  });

  it('projects catch-up history without feeding current-turn observation', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            id: 'historical-agent-message',
            seq: 13,
            localId: 'historical-agent-local',
            createdAt: 123,
            updatedAt: 456,
            content: {
              t: 'plain',
              v: { role: 'agent', content: { type: 'text', text: 'historical output' } },
            },
          },
        ],
      },
    } as any);
    const onObservedMessage = vi.fn();
    const emit = vi.fn();

    await catchUpSessionMessagesAfterSeq({
      token: 't',
      sessionId: 's1',
      afterSeq: 10,
      onUpdate: (update) => {
        handleSessionNewMessageUpdate({
          update,
          sessionId: 's1',
          encryptionKey: new Uint8Array(32),
          encryptionVariant: 'legacy',
          receivedMessageIds: new Set<string>(),
          replayPreviouslyObservedMessageIdsForObservation: true,
          lastObservedMessageSeq: 10,
          lastObservedUserMessageSeq: 0,
          hasSelfEchoSuppressedLocalId: () => false,
          hasPendingQueueMaterializedLocalId: () => false,
          deleteMaterializedLocalId: () => undefined,
          onObservedMessage,
          emit,
          debug: () => undefined,
          debugLargeJson: () => undefined,
        });
      },
    });

    expect(onObservedMessage).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('message', expect.objectContaining({
      createdAt: 123,
      serverCreatedAt: 123,
    }));
  });

  it('ignores transcript messages with malformed seq values', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            id: 'm1',
            seq: '12',
            createdAt: 123,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
          },
        ],
      },
    } as any);

    const updates: any[] = [];
    await catchUpSessionMessagesAfterSeq({
      token: 't',
      sessionId: 's1',
      afterSeq: 10,
      onUpdate: (u) => updates.push(u),
    });

    expect(updates).toHaveLength(0);
  });

  it('throws terminal auth responses instead of treating them as empty catch-up', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 401,
      data: { messages: [] },
    } as any);

    await expect(
      catchUpSessionMessagesAfterSeq({
        token: 'expired',
        sessionId: 's1',
        afterSeq: 10,
        onUpdate: vi.fn(),
      }),
    ).rejects.toMatchObject({
      name: 'HttpStatusError',
      code: 'not_authenticated',
      response: { status: 401 },
    } satisfies Partial<HttpStatusError & { code: string }>);
  });

  it('normalizes axios-style rejected auth errors into the canonical auth carrier', async () => {
    vi.spyOn(axios, 'get').mockRejectedValueOnce({
      response: {
        status: 403,
      },
    });

    await expect(
      catchUpSessionMessagesAfterSeq({
        token: 'expired',
        sessionId: 's1',
        afterSeq: 10,
        onUpdate: vi.fn(),
      }),
    ).rejects.toMatchObject({
      name: 'HttpStatusError',
      code: 'not_authenticated',
      response: { status: 403 },
    } satisfies Partial<HttpStatusError & { code: string }>);
  });
});
