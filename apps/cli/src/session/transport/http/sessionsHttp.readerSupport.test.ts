import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { ConnectedServiceIdSchema } from '@happier-dev/protocol';

describe('session HTTP connected-service reader support', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

  it('advertises support across detail, list variants, and turn-status reads while preserving pagination', async () => {
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => ({
      status: String(url).includes('/turns') || new URL(String(url)).pathname === '/v2/sessions/session-1' ? 404 : 200,
      data: { sessions: [], nextCursor: null, hasNext: false },
    }));
    const { fetchSessionById, fetchSessionsPage, fetchSessionTurnsProjection } = await import('./sessionsHttp');
    await fetchSessionById({ token: 'token', sessionId: 'session-1' });
    await fetchSessionsPage({ token: 'token', cursor: 'next', limit: 10 });
    await fetchSessionsPage({ token: 'token', activeOnly: true });
    await fetchSessionsPage({ token: 'token', archivedOnly: true });
    await fetchSessionTurnsProjection({ token: 'token', sessionId: 'session-1' });
    for (const [rawUrl] of get.mock.calls) {
      const url = new URL(String(rawUrl));
      expect(JSON.parse(url.searchParams.get('happierConnectedServices') ?? 'null')).toEqual(ConnectedServiceIdSchema.options);
    }
    expect(get.mock.calls[1]?.[1]?.params).toEqual({ cursor: 'next', limit: 10 });
  });
});
