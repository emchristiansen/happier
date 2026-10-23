import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

import {
  SESSION_SEND_RETRY_WINDOW_MS,
  claimSessionSendLocalId,
  deriveSessionSendToolCallLocalId,
  type SessionSendRetryInputs,
} from './sessionSendLocalId';

const inputs: SessionSendRetryInputs = {
  target: 'sess-target',
  message: 'READY TO MOVE',
  requestedAction: { v: 1, kind: 'steer_if_active' },
  permissionModeOverride: null,
  modelOverride: { set: false },
  pendingAdmissionMode: null,
};
const cliIdentity = { senderSessionId: 'cli-global', providerToolCallId: null } as const;

describe('claimSessionSendLocalId', () => {
  let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
  let homeDir = '';
  let nowMs = 1_000_000;
  const now = () => nowMs;

  beforeEach(async () => {
    homeDir = await createTempDir('happier-send-ledger-');
    process.env.HAPPIER_HOME_DIR = homeDir;
    nowMs = 1_000_000;
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

  it('reuses the localId of an unsuccessful attempt inside the window and re-arms it on each failure', async () => {
    const first = await claimSessionSendLocalId({ identity: cliIdentity, inputs, nowMs: now });
    await first.settle('unsuccessful');

    nowMs += SESSION_SEND_RETRY_WINDOW_MS - 1;
    const second = await claimSessionSendLocalId({ identity: cliIdentity, inputs, nowMs: now });
    await second.settle('unsuccessful');

    nowMs += SESSION_SEND_RETRY_WINDOW_MS - 1;
    const third = await claimSessionSendLocalId({ identity: cliIdentity, inputs, nowMs: now });

    expect(second.localId).toBe(first.localId);
    expect(third.localId).toBe(first.localId);
  });

  it('gives a fresh localId after success, after a refusal, and after the window lapses', async () => {
    const succeeded = await claimSessionSendLocalId({ identity: cliIdentity, inputs, nowMs: now });
    await succeeded.settle('succeeded');
    const afterSuccess = await claimSessionSendLocalId({ identity: cliIdentity, inputs, nowMs: now });
    await afterSuccess.settle('refused');
    const afterRefusal = await claimSessionSendLocalId({ identity: cliIdentity, inputs, nowMs: now });
    await afterRefusal.settle('unsuccessful');
    nowMs += SESSION_SEND_RETRY_WINDOW_MS + 1;
    const afterWindow = await claimSessionSendLocalId({ identity: cliIdentity, inputs, nowMs: now });

    expect(new Set([succeeded.localId, afterSuccess.localId, afterRefusal.localId, afterWindow.localId]).size).toBe(4);
  });

  it('keys by sender and by every enqueued input', async () => {
    const base = await claimSessionSendLocalId({ identity: cliIdentity, inputs, nowMs: now });
    await base.settle('unsuccessful');
    const variants = await Promise.all([
      claimSessionSendLocalId({ identity: { senderSessionId: 'sess-other', providerToolCallId: null }, inputs, nowMs: now }),
      claimSessionSendLocalId({ identity: cliIdentity, inputs: { ...inputs, target: 'sess-other-target' }, nowMs: now }),
      claimSessionSendLocalId({ identity: cliIdentity, inputs: { ...inputs, message: 'READY TO MOVE.' }, nowMs: now }),
      claimSessionSendLocalId({ identity: cliIdentity, inputs: { ...inputs, requestedAction: { v: 1, kind: 'send_now' } }, nowMs: now }),
      claimSessionSendLocalId({ identity: cliIdentity, inputs: { ...inputs, permissionModeOverride: 'read-only' }, nowMs: now }),
      claimSessionSendLocalId({ identity: cliIdentity, inputs: { ...inputs, modelOverride: { set: true, value: null } }, nowMs: now }),
    ]);

    for (const variant of variants) {
      expect(variant.localId).not.toBe(base.localId);
    }
  });

  it('converges concurrent identical claims on one localId', async () => {
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => claimSessionSendLocalId({ identity: cliIdentity, inputs, nowMs: now })),
    );

    expect(new Set(claims.map((claim) => claim.localId)).size).toBe(1);
  });

  it('derives a tool-call localId from the call id and sender, and prefers a live unsuccessful attempt', async () => {
    const toolIdentity = { senderSessionId: 'sess-sender', providerToolCallId: 'toolu_1' } as const;
    const derived = deriveSessionSendToolCallLocalId(toolIdentity, inputs);
    expect(derived).toBe(deriveSessionSendToolCallLocalId(toolIdentity, inputs));
    expect(derived).not.toBe(deriveSessionSendToolCallLocalId({ ...toolIdentity, senderSessionId: 'sess-other' }, inputs));
    expect(derived.startsWith('session-send-tool-call:')).toBe(true);

    const firstCall = await claimSessionSendLocalId({ identity: toolIdentity, inputs, nowMs: now });
    expect(firstCall.localId).toBe(derived);
    await firstCall.settle('unsuccessful');

    const newCallSameText = await claimSessionSendLocalId({
      identity: { ...toolIdentity, providerToolCallId: 'toolu_2' },
      inputs,
      nowMs: now,
    });
    expect(newCallSameText.localId).toBe(derived);
  });
});
