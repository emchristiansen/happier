import { createHmac } from 'node:crypto';
import { readdir, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

import {
  SESSION_SEND_BUCKET_MS,
  deriveSessionSendLocalId,
  resolveSessionSendBucketStartMs,
  type SessionSendRequestInputs,
} from './sessionSendLocalId';
import {
  SESSION_SEND_ADMISSION_MAX_ENTRIES,
  SESSION_SEND_ADMISSION_RETENTION_MS,
  fingerprintSessionSendRequest,
  preserveSessionSendAdmission as preserveWithFingerprint,
} from './sessionSendAdmissionStore';

const requestFingerprint = fingerprintSessionSendRequest(['READY TO MOVE']);
const preserveSessionSendAdmission = (params: Omit<Parameters<typeof preserveWithFingerprint>[0], 'requestFingerprint'>) =>
  preserveWithFingerprint({ requestFingerprint, ...params });

const key = new Uint8Array(32).fill(5);
const inputs: SessionSendRequestInputs = {
  message: 'READY TO MOVE',
  requestedAction: { v: 1, kind: 'steer_if_active' },
  permissionModeOverride: null,
  modelOverride: { set: false },
  pendingAdmissionMode: null,
};
const identity = { senderSessionId: 'sess-sender', providerToolCallId: null } as const;
// 2026-10-23T19:00:00Z, a bucket boundary.
const boundaryMs = Date.UTC(2026, 9, 23, 19, 0, 0);

function derive(overrides: Partial<Parameters<typeof deriveSessionSendLocalId>[0]> = {}) {
  return deriveSessionSendLocalId({ key, targetSessionId: 'sess-target', identity, inputs, nowMs: boundaryMs, ...overrides });
}

describe('resolveSessionSendBucketStartMs', () => {
  it('floors UTC epoch milliseconds to 10-minute buckets', () => {
    expect(SESSION_SEND_BUCKET_MS).toBe(600_000);
    expect(boundaryMs % SESSION_SEND_BUCKET_MS).toBe(0);
    expect(resolveSessionSendBucketStartMs(boundaryMs)).toBe(boundaryMs);
    expect(resolveSessionSendBucketStartMs(boundaryMs + SESSION_SEND_BUCKET_MS - 1)).toBe(boundaryMs);
    expect(resolveSessionSendBucketStartMs(boundaryMs - 1)).toBe(boundaryMs - SESSION_SEND_BUCKET_MS);
    expect(() => resolveSessionSendBucketStartMs(-1)).toThrow('session_send_clock_invalid');
    expect(() => resolveSessionSendBucketStartMs(1.5)).toThrow('session_send_clock_invalid');
  });
});

describe('deriveSessionSendLocalId', () => {
  it('gives every identical send in one bucket the same localId and the next bucket a new one', () => {
    const first = derive();
    expect(first.startsWith('session-send-text:')).toBe(true);
    expect(derive({ nowMs: boundaryMs + SESSION_SEND_BUCKET_MS - 1 })).toBe(first);
    expect(derive({ nowMs: boundaryMs + SESSION_SEND_BUCKET_MS })).not.toBe(first);
    expect(derive({ nowMs: boundaryMs - 1 })).not.toBe(first);
  });

  it('is an HMAC over a domain-separated, target-namespaced encoding', () => {
    const expected = createHmac('sha256', key).update(JSON.stringify([
      'happier.session-send.local-id.text-bucket.v1',
      'sess-target',
      'sess-sender',
      boundaryMs,
      'READY TO MOVE',
      { v: 1, kind: 'steer_if_active' },
      null,
      ['unset'],
      null,
    ])).digest('hex').slice(0, 32);
    expect(derive()).toBe(`session-send-text:${expected}`);
    expect(derive({ key: new Uint8Array(32).fill(6) })).not.toBe(derive());
  });

  it('separates targets, senders and every enqueued input', () => {
    const base = derive();
    const variants = [
      derive({ targetSessionId: 'sess-other-target' }),
      derive({ identity: { senderSessionId: 'sess-other-sender', providerToolCallId: null } }),
      derive({ inputs: { ...inputs, message: 'READY TO MOVE.' } }),
      derive({ inputs: { ...inputs, requestedAction: { v: 1, kind: 'send_now' } } }),
      derive({ inputs: { ...inputs, permissionModeOverride: 'read-only' } }),
      derive({ inputs: { ...inputs, modelOverride: { set: true, value: null } } }),
      derive({ inputs: { ...inputs, pendingAdmissionMode: 'continuation_if_no_queued_user_input' } }),
    ];
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  it('prefers a provider tool-call id, with no time component', () => {
    const toolIdentity = { senderSessionId: 'sess-sender', providerToolCallId: 'toolu_1' } as const;
    const byCall = derive({ identity: toolIdentity });
    expect(byCall.startsWith('session-send-tool-call:')).toBe(true);
    expect(derive({ identity: toolIdentity, nowMs: boundaryMs + 5 * SESSION_SEND_BUCKET_MS })).toBe(byCall);
    expect(derive({ identity: { ...toolIdentity, providerToolCallId: 'toolu_2' } })).not.toBe(byCall);
    expect(byCall).not.toBe(derive());
  });
});

describe('preserveSessionSendAdmission', () => {
  let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
  let homeDir = '';

  beforeEach(async () => {
    homeDir = await createTempDir('happier-send-admissions-');
    process.env.HAPPIER_HOME_DIR = homeDir;
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  afterEach(async () => {
    await removeTempDir(homeDir);
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  const body = (ciphertext: string, localId = 'local-1') => ({
    localId,
    ciphertext,
    messageRole: 'user' as const,
    requestedAction: { v: 1 as const, kind: 'steer_if_active' as const },
  });

  it('keeps the first body per (session, localId) and returns it to later attempts', async () => {
    expect(await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body('first') })).toEqual(body('first'));
    expect(await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body('resealed') })).toEqual(body('first'));
    expect(await preserveSessionSendAdmission({ sessionId: 'sess-b', candidate: body('other-session') })).toEqual(body('other-session'));
    expect(await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body('other-id', 'local-2') })).toEqual(body('other-id', 'local-2'));
  });

  it('converges concurrent first attempts on one body', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body(`candidate-${index}`) })));
    expect(new Set(results.map((result) => (result as { ciphertext?: string }).ciphertext)).size).toBe(1);
  });

  it('issues a different request under a kept localId as itself, without replacing the kept body', async () => {
    await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body('first') });
    const otherRequest = fingerprintSessionSendRequest(['other text']);
    expect(await preserveWithFingerprint({ sessionId: 'sess-a', requestFingerprint: otherRequest, candidate: body('other') }))
      .toEqual(body('other'));
    expect(await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body('resealed') })).toEqual(body('first'));
  });

  it('drops other bodies older than the retention when publishing', async () => {
    let nowMs = 1_000_000;
    await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body('old'), nowMs: () => nowMs });
    nowMs += SESSION_SEND_ADMISSION_RETENTION_MS + 1;
    await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body('new', 'local-2'), nowMs: () => nowMs });
    expect(await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body('resealed'), nowMs: () => nowMs }))
      .toEqual(body('resealed'));
  });

  async function storeDirectory(): Promise<string> {
    const { configuration } = await import('@/configuration');
    return join(configuration.activeServerDir, 'session-send-admissions');
  }

  /** The stored bodies: one `.json` file each (any other file holds no message). */
  async function listEntries(): Promise<string[]> {
    return (await readdir(await storeDirectory())).filter((name) => !name.startsWith('.') && name.endsWith('.json')).sort();
  }

  it('removes a body just over the retention on write and keeps one exactly at it', async () => {
    const t0 = 1_000_000;
    await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body('over', 'local-over'), nowMs: () => t0 });
    await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body('inside', 'local-inside'), nowMs: () => t0 + 1 });
    const writeAtMs = t0 + 1 + SESSION_SEND_ADMISSION_RETENTION_MS;
    await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body('trigger', 'local-trigger'), nowMs: () => writeAtMs });

    expect(await listEntries()).toHaveLength(2);
    expect(await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body('resealed', 'local-inside'), nowMs: () => writeAtMs }))
      .toEqual(body('inside', 'local-inside'));
    expect(await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body('resealed', 'local-over'), nowMs: () => writeAtMs }))
      .toEqual(body('resealed', 'local-over'));
  });

  it('evicts the oldest bodies by storedAtMs to stay within the cap', async () => {
    let nowMs = 1_000_000;
    for (let index = 0; index < SESSION_SEND_ADMISSION_MAX_ENTRIES; index += 1) {
      nowMs += 1;
      await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body(`body-${index}`, `local-${index}`), nowMs: () => nowMs });
    }
    expect(await listEntries()).toHaveLength(SESSION_SEND_ADMISSION_MAX_ENTRIES);

    nowMs += 1;
    await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body('newest', 'local-newest'), nowMs: () => nowMs });
    expect(await listEntries()).toHaveLength(SESSION_SEND_ADMISSION_MAX_ENTRIES);
    // The second oldest survives; the oldest was evicted, so its resend is issued as itself.
    expect(await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body('resealed', 'local-1'), nowMs: () => nowMs }))
      .toEqual(body('body-1', 'local-1'));
    expect(await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body('resealed', 'local-0'), nowMs: () => nowMs }))
      .toEqual(body('resealed', 'local-0'));
  }, 120_000);

  it('removes temporary files older than the retention and keeps fresh ones', async () => {
    await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body('first') });
    const directory = await storeDirectory();
    const staleSeconds = (Date.now() - SESSION_SEND_ADMISSION_RETENTION_MS - 60_000) / 1000;
    await writeFile(join(directory, '.tmp-dead-1'), '{}');
    await utimes(join(directory, '.tmp-dead-1'), staleSeconds, staleSeconds);
    await writeFile(join(directory, '.tmp-live-1'), '{}');

    await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body('second', 'local-2') });
    const names = await readdir(directory);
    expect(names).not.toContain('.tmp-dead-1');
    expect(names).toContain('.tmp-live-1');
  });

  it('keeps issuing a committed body while a stale cleaner and a third publisher interleave', async () => {
    // An old attempt under X left body A, now expired. Cleaner R (publishing
    // another key) judges A stale and pauses. Another cleaner removes A; a
    // send publishes B under X and the relay commits it, its acknowledgement
    // lost. Every retry of that request, before and after R resumes, must
    // issue B's exact bytes, whatever R does to the store meanwhile.
    const t0 = 1_000_000;
    const t1 = t0 + SESSION_SEND_ADMISSION_RETENTION_MS + 1;
    await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body('A'), nowMs: () => t0 });
    let removals = 0;

    await preserveSessionSendAdmission({
      sessionId: 'sess-a',
      candidate: body('unrelated', 'local-2'),
      nowMs: () => t1,
      beforeRemove: async (fileName) => {
        removals += 1;
        if (removals === 1) {
          await unlink(join(await storeDirectory(), fileName));
          expect(await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body('B'), nowMs: () => t1 }))
            .toEqual(body('B'));
        }
        // Third publisher: the retry with resealed bytes C.
        expect(await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body('C'), nowMs: () => t1 }))
          .toEqual(body('B'));
      },
    });

    expect(removals).toBeGreaterThan(0);
    expect(await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body('D'), nowMs: () => t1 }))
      .toEqual(body('B'));
    expect((await readdir(await storeDirectory())).filter((name) => name.startsWith('.'))).toEqual([]);
  });

  it('holds the cap after two distinct-key publications interleave at 255 bodies', async () => {
    let nowMs = 1_000_000;
    for (let index = 0; index < SESSION_SEND_ADMISSION_MAX_ENTRIES - 1; index += 1) {
      nowMs += 1;
      await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body(`body-${index}`, `local-${index}`), nowMs: () => nowMs });
    }
    expect(await listEntries()).toHaveLength(SESSION_SEND_ADMISSION_MAX_ENTRIES - 1);
    nowMs += 1;
    let interleaved = false;

    // X has scanned the store and is about to publish when Y publishes in full.
    await preserveSessionSendAdmission({
      sessionId: 'sess-a',
      candidate: body('x', 'local-x'),
      nowMs: () => nowMs,
      beforeLink: async () => {
        if (interleaved) return;
        interleaved = true;
        await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body('y', 'local-y'), nowMs: () => nowMs });
      },
    });

    expect(interleaved).toBe(true);
    expect((await listEntries()).length).toBeLessThanOrEqual(SESSION_SEND_ADMISSION_MAX_ENTRIES);
    expect(await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body('resealed', 'local-x'), nowMs: () => nowMs }))
      .toEqual(body('x', 'local-x'));
    expect(await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body('resealed', 'local-y'), nowMs: () => nowMs }))
      .toEqual(body('y', 'local-y'));
  }, 120_000);

  it('converges two attempts on one body across a window boundary', async () => {
    const boundary = 2 * SESSION_SEND_ADMISSION_RETENTION_MS;
    let lateNowMs = boundary - 1;
    // The late attempt read its window just before the boundary; the other
    // attempt runs entirely after it, before the late one links.
    const late = preserveSessionSendAdmission({
      sessionId: 'sess-a',
      candidate: body('late'),
      nowMs: () => lateNowMs,
      beforeLink: async () => {
        lateNowMs = boundary + 5;
      },
    });
    const early = await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body('after-boundary'), nowMs: () => boundary + 1 });
    const lateResult = await late;
    expect(lateResult).toEqual(early);
    expect(await preserveSessionSendAdmission({ sessionId: 'sess-a', candidate: body('retry'), nowMs: () => boundary + 10 }))
      .toEqual(early);
  });
});
