import { describe, expect, it } from 'vitest';

import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import { createDaemonSpawnAttemptRegistry } from './daemonSpawnAttemptRegistry';

describe('createDaemonSpawnAttemptRegistry', () => {
  it('retains the original pending deadline when the same accepted runner is rediscovered', () => {
    let now = 0;
    const registry = createDaemonSpawnAttemptRegistry({ ttlMs: 1000, now: () => now });
    const accepted = { type: 'success', sessionId: 'sess-retained' } as const;
    registry.rememberAccepted({ spawnNonce: 'nonce-retained', result: accepted });
    now = 500;
    registry.rememberAccepted({ spawnNonce: 'nonce-retained', result: accepted });
    expect(registry.replay('nonce-retained')).toMatchObject({ sessionId: 'sess-retained', runnerAcceptance: 'same_request_runner' });
    now = 1000;
    expect(registry.resolve('nonce-retained')).toEqual({ status: 'not_found' });
  });

  it('settles an accepted nonce to terminal child-exit failure and never lets a late webhook resurrect it', () => {
    const registry = createDaemonSpawnAttemptRegistry({ ttlMs: 60_000 });
    const accepted = {
      type: 'success' as const,
      spawnNonce: 'nonce-child-exit',
      sessionId: 'sess-seeded',
      runnerAcceptance: 'newly_accepted' as const,
    };
    registry.rememberAccepted({
      spawnNonce: 'nonce-child-exit',
      result: accepted,
    });

    expect(registry.resolve('nonce-child-exit')).toEqual({ status: 'pending' });
    expect(registry.replay('nonce-child-exit')).toMatchObject({
      type: 'success', sessionId: 'sess-seeded', runnerAcceptance: 'same_request_runner',
    });

    registry.settle('nonce-child-exit', {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
      errorMessage: 'Child process exited before session webhook (pid=8892, code=1, signal=null)',
    });

    expect(registry.resolve('nonce-child-exit')).toEqual({
      status: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
      errorMessage: 'Child process exited before session webhook (pid=8892, code=1, signal=null)',
    });
    expect(registry.replay('nonce-child-exit')).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
      errorMessage: 'Child process exited before session webhook (pid=8892, code=1, signal=null)',
    });

    registry.settle('nonce-child-exit', {
      type: 'success',
      sessionId: 'sess-too-late',
    });

    expect(registry.resolve('nonce-child-exit')).toEqual({
      status: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
      errorMessage: 'Child process exited before session webhook (pid=8892, code=1, signal=null)',
    });
  });

  it('settles an accepted nonce to normal webhook success and replays that session id', () => {
    const registry = createDaemonSpawnAttemptRegistry({ ttlMs: 60_000 });
    registry.rememberAccepted({
      spawnNonce: 'nonce-success',
      result: {
        type: 'success',
        spawnNonce: 'nonce-success',
        sessionId: 'sess-seeded',
        runnerAcceptance: 'newly_accepted',
      },
    });

    expect(registry.resolve('nonce-success')).toEqual({ status: 'pending' });

    registry.settle('nonce-success', {
      type: 'success',
      sessionId: 'sess-success',
    });

    expect(registry.resolve('nonce-success')).toEqual({
      status: 'success',
      sessionId: 'sess-success',
    });
    expect(registry.replay('nonce-success')).toEqual({
      type: 'success',
      sessionId: 'sess-success',
      spawnNonce: 'nonce-success',
      runnerAcceptance: 'same_request_runner',
    });
    registry.rememberAccepted({ spawnNonce: 'nonce-success', result: {
      type: 'success', sessionId: 'sess-seeded', runnerAcceptance: 'same_request_runner',
    } });
    registry.settle('nonce-success', {
      type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED, errorMessage: 'Late failure',
    });
    expect(registry.resolve('nonce-success')).toEqual({ status: 'success', sessionId: 'sess-success' });
  });
});
