import { describe, expect, it } from 'vitest';

import { createKeyedFollowUpRuns } from '@/utils/keyedFollowUpRuns';
import { ConnectedServiceRuntimeRegistry, type ConnectedServiceRuntimeTarget } from '../runtimeRegistry/registry';
import { ConnectedServiceSessionAuthSwitchLockRegistry } from '../runtimeAuth/connectedServiceSessionAuthSwitchCore';
import { registerConnectedServiceRuntimeTargetForDaemon } from './runtimeTargetRegistration';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('runtime target follow-up auth ownership', () => {
  it('queues an independent forced cohort behind the owner that registered the target', async () => {
    const locks = new ConnectedServiceSessionAuthSwitchLockRegistry();
    const registry = new ConnectedServiceRuntimeRegistry();
    const registered = deferred<ConnectedServiceRuntimeTarget>();
    const passiveRead = deferred<void>();
    const releaseOwner = deferred<void>();
    const attemptedFollowUp = deferred<boolean>();
    let followUpEntered = false;
    const queue = createKeyedFollowUpRuns<ConnectedServiceRuntimeTarget, void, void>({
      run: async ({ key: target, kind }) => {
        if (kind === 'initial') {
          // The passive projection's canonical read fails before a successful epoch stamp.
          await passiveRead.promise;
          return;
        }
        attemptedFollowUp.resolve(locks.isHeldByAnotherOwner(target.sessionId!));
        await locks.runExclusive(target.sessionId!, async () => {
          followUpEntered = true;
        });
      },
    });
    let passive: Promise<void> | undefined;
    registry.onTargetRegistration(({ target }) => {
      passive = queue.request(target, undefined, { requireStartAfterRequest: false });
      void passive.catch(() => {});
    });
    const owner = locks.runExclusive('session', async () => {
      const target = registerConnectedServiceRuntimeTargetForDaemon({
        runtimeRegistry: registry,
        pid: 4321,
        agentId: 'codex',
        sessionId: 'session',
        materializationKey: 'generation-1',
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'group', groupId: 'team', profileId: 'work' },
          },
        },
      });
      if (!target) throw new Error('expected runtime target');
      registered.resolve(target);
      // Model the post-registration continuation while the auth transition still owns the lock.
      await releaseOwner.promise;
    });
    const target = await registered.promise;
    const forced = queue.request(target, undefined, { requireStartAfterRequest: true });
    const joined = queue.request(target, undefined, { requireStartAfterRequest: true });
    expect(joined).toBe(forced);
    passiveRead.reject(new Error('canonical group read failed'));
    try {
      await expect(passive).rejects.toThrow('canonical group read failed');
      // This signal is emitted immediately before acquisition; no timing-based sleep is needed.
      expect(await attemptedFollowUp.promise).toBe(true);
      expect(followUpEntered).toBe(false);
      expect(registry.getByPid(target.pid)).toBe(target);
    } finally {
      releaseOwner.resolve();
      await Promise.all([owner, forced, joined]);
    }
    expect(followUpEntered).toBe(true);
  });

  it('preserves a forced requester’s legitimate nesting under its own live owner', async () => {
    const locks = new ConnectedServiceSessionAuthSwitchLockRegistry();
    const passive = deferred<void>();
    const requested = deferred<void>();
    const attemptedFollowUp = deferred<boolean>();
    const releaseOwner = deferred<void>();
    let nestedEntered = false;
    let forced: Promise<void> | undefined;
    const queue = createKeyedFollowUpRuns<string, void, void>({
      run: async ({ key, kind }) => {
        if (kind === 'initial') return await passive.promise;
        attemptedFollowUp.resolve(locks.isHeldByAnotherOwner(key));
        await locks.runExclusive(key, async () => { nestedEntered = true; });
      },
    });
    const initial = queue.request('session', undefined, { requireStartAfterRequest: false });
    const owner = locks.runExclusive('session', async () => {
      forced = queue.request('session', undefined, { requireStartAfterRequest: true });
      requested.resolve();
      await releaseOwner.promise;
    });
    await requested.promise;
    passive.resolve();
    try {
      expect(await attemptedFollowUp.promise).toBe(false);
      expect(nestedEntered).toBe(true);
    } finally {
      releaseOwner.resolve();
      await Promise.all([initial, owner, forced]);
    }
  });
});
