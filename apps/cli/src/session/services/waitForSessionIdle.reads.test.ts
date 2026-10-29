import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Credentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
// Keep the HTTP replacement installed through module resets and timed-out test cleanup.
// No test path may fall through to a real request.
const { httpGet } = vi.hoisted(() => ({ httpGet: vi.fn() }));
vi.mock('axios', async () => {
  const { createOfflineAxios } = await import('@/testkit/http/offlineAxios');
  return { default: createOfflineAxios(httpGet) };
});


const sessionId = 'c123456789012345678901234';
const credentials: Credentials = { token: 'idle-read-test', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } };
function session(overrides: Partial<RawSessionRecord> = {}): RawSessionRecord {
  return {
    id: sessionId, seq: 1, createdAt: 0, updatedAt: 0, active: true, activeAt: 0,
    encryptionMode: 'plain', metadata: '{}', metadataVersion: 0,
    agentState: JSON.stringify({ requests: {} }), agentStateVersion: 0, dataEncryptionKey: null,
    latestTurnStatus: 'in_progress', pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0, ...overrides,
  };
}

// HTTP and the socket are system boundaries. All idle/activity/resolution logic stays real.
async function harness(params: {
  readSession?: (index: number) => RawSessionRecord | Promise<RawSessionRecord>;
  transcript?: () => unknown[];
  serviceMs?: number;
} = {}) {
  const handlers = new Map<string, (value: unknown) => void>();
  const disconnect = vi.fn();
  vi.doMock('@/api/session/sockets', () => ({ createSessionScopedSocket: () => ({
    on: (event: string, handler: (value: unknown) => void) => handlers.set(event, handler),
    off: (event: string) => handlers.delete(event), connect: () => undefined, disconnect, close: () => undefined,
  }) }));
  let socketCompleted = false;
  const sessionReads: number[] = [];
  const transcriptReads: number[] = [];
  httpGet.mockImplementation(async (url: string) => {
    if (new URL(String(url)).pathname === `/v2/sessions/${sessionId}`) {
      sessionReads.push(Date.now());
      if (params.serviceMs) await new Promise((resolve) => setTimeout(resolve, params.serviceMs));
      return { status: 200, data: { session: await (params.readSession?.(sessionReads.length) ?? session({ latestTurnStatus: socketCompleted ? 'completed' : 'in_progress' })) } };
    }
    if (String(url).includes(`/sessions/${sessionId}/messages`)) {
      transcriptReads.push(Date.now());
      return { status: 200, data: { messages: params.transcript?.() ?? [] } };
    }
    throw new Error(`Unexpected test HTTP request: ${String(url)}`);
  });
  const { waitForSessionIdle } = await import('./waitForSessionIdle');
  return {
    sessionReads, transcriptReads, disconnect,
    wait: (timeoutMs = 40_000) => waitForSessionIdle({ credentials, idOrPrefix: sessionId, timeoutMs }),
    update: () => {
      socketCompleted = true;
      return handlers.get('update')?.({ id: 'u1', seq: 1, createdAt: Date.now(), body: {
      t: 'update-session', id: sessionId, latestTurnStatus: 'completed', pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
    } });
    },
  };
}

describe('waitForSessionIdle request scheduling', () => {
  let home: string;
  beforeEach(() => {
    vi.resetModules();
    home = mkdtempSync(join(tmpdir(), 'idle-reads-'));
    vi.stubEnv('HAPPIER_HOME_DIR', home);
    httpGet.mockReset().mockRejectedValue(new Error('Unconfigured offline HTTP boundary'));
    vi.stubEnv('HAPPIER_SERVER_URL', 'https://relay.example.invalid');
    vi.stubEnv('HAPPIER_LOCAL_SERVER_URL', 'https://relay.example.invalid');
    vi.stubEnv('HAPPIER_PUBLIC_SERVER_URL', 'https://relay.example.invalid');
    vi.stubEnv('HAPPIER_ACTIVE_SERVER_ID', ''); vi.useFakeTimers(); vi.setSystemTime(0);
    vi.stubEnv('HAPPIER_SESSION_WAIT_IDLE_CONFIRM_MS', '250');
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); rmSync(home, { recursive: true, force: true }); });

  it.each([0, 100])('bounds projection reads over a 40s busy wait with %ims HTTP service', async (serviceMs) => {
    const h = await harness({ serviceMs });
    const result = h.wait();
    await vi.advanceTimersByTimeAsync(40_000);
    await expect(result).resolves.toEqual({ ok: false, code: 'timeout' });
    expect(h.sessionReads).toEqual(serviceMs === 0
      ? [0, 250, 750, 1750, 3750, 7750, 12750, 17750, 22750, 27750, 32750, 37750]
      : [0, 350, 950, 2050, 4150, 8250, 13350, 18450, 23550, 28650, 33750, 38850]);
    expect(h.transcriptReads).toEqual([]);
    expect(h.disconnect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.sessionReads).toHaveLength(12);
  });

  it('keeps the initial idle confirmation and fresh read at 250ms', async () => {
    const h = await harness({ readSession: () => session({ latestTurnStatus: 'completed' }) });
    const result = h.wait();
    let settled = false;
    void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(249);
    expect(settled).toBe(false); expect(h.sessionReads).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ ok: true, idle: true, observedAt: 250 });
    expect(h.sessionReads).toEqual([0, 250]);
  });

  it('observes socket completion promptly during backoff and cancels future fallback reads', async () => {
    const h = await harness(); const result = h.wait();
    await vi.advanceTimersByTimeAsync(8_000); h.update();
    await expect(result).resolves.toMatchObject({ ok: true, idle: true, observedAt: 8_000 });
    expect(h.sessionReads).toEqual([0, 250, 750, 1750, 3750, 7750, 8000]);
    await vi.advanceTimersByTimeAsync(10_000); expect(h.sessionReads).toHaveLength(7);
  });

  it('retains post-idle fresh AgentState proof and rejects local user control', async () => {
    const h = await harness({ readSession: (index) => session(index < 3 ? {} : {
      latestTurnStatus: 'completed', agentState: JSON.stringify({ controlledByUser: true, requests: {} }),
    }) });
    const result = h.wait(2_000);
    await vi.advanceTimersByTimeAsync(750); expect(h.sessionReads).toEqual([0, 250, 750, 750]);
    await vi.advanceTimersByTimeAsync(1_250);
    await expect(result).resolves.toEqual({ ok: false, code: 'timeout' });
  });

  it.each(['socket', 'timeout'] as const)('stops an in-flight fallback from issuing another read after %s completion', async (completion) => {
    let finishRead: ((value: RawSessionRecord) => void) | undefined;
    const h = await harness({ readSession: (index) => index === 2
      ? new Promise<RawSessionRecord>((resolve) => { finishRead = resolve; })
      : session(),
    });
    const result = h.wait(1_000);
    await vi.advanceTimersByTimeAsync(250);
    expect(h.sessionReads).toEqual([0, 250]);
    if (completion === 'socket') {
      h.update();
      await expect(result).resolves.toMatchObject({ ok: true, idle: true });
    } else {
      await vi.advanceTimersByTimeAsync(750);
      await expect(result).resolves.toEqual({ ok: false, code: 'timeout' });
    }
    if (!finishRead) throw new Error('Expected an in-flight projection request');
    finishRead(session({ latestTurnStatus: 'completed' }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.sessionReads).toEqual([0, 250]);
  });

  it('fails closed on session and transcript failures within the original deadline', async () => {
    const h = await harness({
      readSession: (index) => { if (index > 1) throw new Error('session unavailable'); return session(); },
      transcript: () => { throw new Error('transcript unavailable'); },
    });
    const result = h.wait(2_000); await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toEqual({ ok: false, code: 'timeout' });
    expect(h.sessionReads).toEqual([0, 250, 750, 1750]); expect(h.transcriptReads).toEqual([250, 750, 1750]);
  });

  it('preserves transcript-only recheck spacing without an initial projection', async () => {
    const h = await harness({
      readSession: () => session({ latestTurnStatus: undefined }),
      transcript: () => [{ seq: 1, createdAt: 0, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'work' } } } }],
    });
    const result = h.wait(1_000); await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toEqual({ ok: false, code: 'timeout' });
    expect(h.sessionReads).toEqual([0]); expect(h.transcriptReads).toEqual([0, 250, 500, 750]);
  });
});
