import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pageOpenCodeTranscript } from './pageOpenCodeTranscript';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('pageOpenCodeTranscript', () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.HAPPIER_OPENCODE_SERVER_URL;

  beforeEach(() => {
    process.env.HAPPIER_OPENCODE_SERVER_URL = 'http://example.test';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (typeof originalUrl === 'string') {
      process.env.HAPPIER_OPENCODE_SERVER_URL = originalUrl;
    } else {
      delete process.env.HAPPIER_OPENCODE_SERVER_URL;
    }
  });

  it('pages OpenCode messages from newest backwards', async () => {
    const messages = [
      { id: 'm1', role: 'user', createdAt: '2026-01-01T00:00:00.000Z', parts: [{ type: 'text', text: 'one' }] },
      { id: 'm2', role: 'assistant', createdAt: '2026-01-01T00:00:01.000Z', parts: [{ type: 'text', text: 'a' }] },
      { id: 'm3', role: 'user', createdAt: '2026-01-01T00:00:02.000Z', parts: [{ type: 'text', text: 'two' }] },
      { id: 'm4', role: 'assistant', createdAt: '2026-01-01T00:00:03.000Z', parts: [{ type: 'text', text: 'b' }] },
    ];

    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : String((input as any)?.url ?? '');
      if (url.includes('/global/health')) {
        return jsonResponse({ healthy: true, version: '1.2.17' });
      }
      if (url.includes('/session/sess-1/message')) {
        return jsonResponse(messages);
      }
      return jsonResponse({});
    }) as any;

    const first = await pageOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: null, directory: null },
      remoteSessionId: 'sess-1',
      direction: 'older',
      maxBytes: 1024 * 1024,
      maxItems: 2,
    });

    expect(first.items).toHaveLength(2);
    expect(((first.items[0]?.raw as any)?.content as any)?.text).toBe('two');
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    expect(first.tailCursor).toBeTruthy();

    const second = await pageOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: null, directory: null },
      remoteSessionId: 'sess-1',
      direction: 'older',
      cursor: first.nextCursor ?? undefined,
      maxBytes: 1024 * 1024,
      maxItems: 10,
    });

    expect(second.items).toHaveLength(2);
    expect(((second.items[0]?.raw as any)?.content as any)?.text).toBe('one');
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it('maps current OpenCode server message info envelopes', async () => {
    const messages = [
      {
        info: {
          id: 'msg-user',
          role: 'user',
          sessionID: 'sess-1',
          time: { created: 1_779_095_233_468 },
          model: { providerID: 'openai', modelID: 'gpt-5.4' },
        },
        parts: [{ type: 'text', text: 'hello from user', id: 'prt-user', sessionID: 'sess-1', messageID: 'msg-user' }],
      },
      {
        info: {
          id: 'msg-assistant',
          parentID: 'msg-user',
          role: 'assistant',
          sessionID: 'sess-1',
          time: { created: 1_779_095_233_767, completed: 1_779_095_235_639 },
          providerID: 'openai',
          modelID: 'gpt-5.4',
        },
        parts: [{ type: 'text', text: 'hello from assistant', id: 'prt-assistant', sessionID: 'sess-1', messageID: 'msg-assistant' }],
      },
    ];

    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : String((input as any)?.url ?? '');
      if (url.includes('/global/health')) {
        return jsonResponse({ healthy: true, version: '1.14.41' });
      }
      if (url.includes('/session/sess-1/message')) {
        return jsonResponse(messages);
      }
      return jsonResponse({});
    }) as any;

    const page = await pageOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: null, directory: null },
      remoteSessionId: 'sess-1',
      direction: 'older',
      maxBytes: 1024 * 1024,
      maxItems: 10,
    });

    expect(page.items.map((item) => item.id)).toEqual(['msg-user', 'msg-assistant']);
    expect(page.items.map((item) => item.createdAtMs)).toEqual([1_779_095_233_468, 1_779_095_233_767]);
    expect((page.items[0]?.raw as any)?.role).toBe('user');
    expect(((page.items[0]?.raw as any)?.content as any)?.text).toBe('hello from user');
    expect((page.items[1]?.raw as any)?.role).toBe('agent');
    expect(((page.items[1]?.raw as any)?.content as any)?.data?.message).toBe('hello from assistant');
  });

  it('marks pages truncated when maxBytes prevents returning all available items', async () => {
    const messages = [
      { id: 'm1', role: 'assistant', createdAt: '2026-01-01T00:00:00.000Z', parts: [{ type: 'text', text: '12345678901234567890' }] },
      { id: 'm2', role: 'assistant', createdAt: '2026-01-01T00:00:01.000Z', parts: [{ type: 'text', text: 'abcdefghijabcdefghij' }] },
    ];

    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : String((input as any)?.url ?? '');
      if (url.includes('/global/health')) {
        return jsonResponse({ healthy: true, version: '1.2.17' });
      }
      if (url.includes('/session/sess-1/message')) {
        return jsonResponse(messages);
      }
      return jsonResponse({});
    }) as any;

    const page = await pageOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: null, directory: null },
      remoteSessionId: 'sess-1',
      direction: 'older',
      maxBytes: 140,
      maxItems: 10,
    });

    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.truncated).toBe(true);
    expect(page.truncationReason).toBe('page_limit');
  });

  it('does not skip unseen tail messages when byte truncation cuts a backward page short', async () => {
    const messages = [
      { id: 'm1', role: 'assistant', createdAt: '2026-01-01T00:00:00.000Z', parts: [{ type: 'text', text: '11111111111111111111' }] },
      { id: 'm2', role: 'assistant', createdAt: '2026-01-01T00:00:01.000Z', parts: [{ type: 'text', text: '22222222222222222222' }] },
      { id: 'm3', role: 'assistant', createdAt: '2026-01-01T00:00:02.000Z', parts: [{ type: 'text', text: '33333333333333333333' }] },
      { id: 'm4', role: 'assistant', createdAt: '2026-01-01T00:00:03.000Z', parts: [{ type: 'text', text: '44444444444444444444' }] },
    ];

    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : String((input as any)?.url ?? '');
      if (url.includes('/global/health')) {
        return jsonResponse({ healthy: true, version: '1.2.17' });
      }
      if (url.includes('/session/sess-1/message')) {
        return jsonResponse(messages);
      }
      return jsonResponse({});
    }) as any;

    const first = await pageOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: null, directory: null },
      remoteSessionId: 'sess-1',
      direction: 'older',
      maxBytes: 140,
      maxItems: 3,
    });

    expect(first.items.map((item) => item.id)).toEqual(['m4']);
    expect(first.hasMore).toBe(true);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toBeTruthy();

    const second = await pageOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: null, directory: null },
      remoteSessionId: 'sess-1',
      direction: 'older',
      cursor: first.nextCursor ?? undefined,
      maxBytes: 1024 * 1024,
      maxItems: 10,
    });

    expect(second.items.map((item) => item.id)).toEqual(['m1', 'm2', 'm3']);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it('omits compaction summaries while advancing backward pagination', async () => {
    const messages = [
      { id: 'm1', role: 'assistant', createdAt: '2026-01-01T00:00:00.000Z', parts: [{ type: 'text', text: 'visible' }] },
      {
        info: {
          id: 'm2',
          role: 'assistant',
          summary: true,
          mode: 'compaction',
          agent: 'compaction',
          time: { created: 1_779_095_233_000, completed: 1_779_095_234_000 },
        },
        parts: [{ type: 'text', text: 'SUMMARY_TWO_SHOULD_NOT_APPEAR' }],
      },
      {
        info: {
          id: 'm3',
          role: 'assistant',
          summary: true,
          mode: 'compaction',
          agent: 'compaction',
          time: { created: 1_779_095_235_000, completed: 1_779_095_236_000 },
        },
        parts: [{ type: 'text', text: 'SUMMARY_THREE_SHOULD_NOT_APPEAR' }],
      },
    ];

    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : String((input as any)?.url ?? '');
      if (url.includes('/global/health')) {
        return jsonResponse({ healthy: true, version: '1.14.41' });
      }
      if (url.includes('/session/sess-1/message')) {
        return jsonResponse(messages);
      }
      return jsonResponse({});
    }) as any;

    const first = await pageOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: null, directory: null },
      remoteSessionId: 'sess-1',
      direction: 'older',
      maxBytes: 1024 * 1024,
      maxItems: 2,
    });

    expect(first.items).toEqual([]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();

    const second = await pageOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: null, directory: null },
      remoteSessionId: 'sess-1',
      direction: 'older',
      cursor: first.nextCursor ?? undefined,
      maxBytes: 1024 * 1024,
      maxItems: 2,
    });

    expect(second.items.map((item) => item.id)).toEqual(['m1']);
    expect(JSON.stringify([...first.items, ...second.items])).not.toContain('SUMMARY_');
    expect(second.hasMore).toBe(false);
  });
});
