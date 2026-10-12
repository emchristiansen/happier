import { describe, expect, it } from 'vitest';

import {
  formatPinnedDaemonServiceRestartCommand,
  planServiceDaemonsRestartAfterCliUpdate,
  type ServiceDaemonBeforeCliUpdate,
} from './serviceDaemonsToRestartAfterCliUpdate.js';

function candidate(label: string, facts: Partial<Omit<ServiceDaemonBeforeCliUpdate<string>, 'label' | 'target'>> = {}): ServiceDaemonBeforeCliUpdate<string> {
  return { label, target: label, serviceInstalled: true, daemonRunning: true, serviceManaged: true, ...facts };
}

describe('planServiceDaemonsRestartAfterCliUpdate', () => {
  it('restarts the default-following service daemon and every pinned service daemon that ran before the update', async () => {
    const restarted: string[] = [];
    const plan = planServiceDaemonsRestartAfterCliUpdate({
      defaultFollowing: candidate('default'),
      pinned: [
        candidate('company'),
        candidate('personal'),
        candidate('stopped', { daemonRunning: false }),
        candidate('manual', { serviceManaged: false }),
        candidate('uninstalled', { serviceInstalled: false }),
      ],
      restartAndProve: async (target) => {
        restarted.push(target);
      },
      reportUnownedRestartFailure: () => undefined,
    });

    expect(plan.labels).toEqual(['default', 'company', 'personal']);
    await plan.restart?.({ expectedVersion: '1.1.0', phase: 'activated' });
    expect(restarted).toEqual(['default', 'company', 'personal']);
  });

  it('attempts every daemon before reporting, and names each one that did not come back', async () => {
    const attempted: string[] = [];
    const plan = planServiceDaemonsRestartAfterCliUpdate({
      defaultFollowing: candidate('default'),
      pinned: [candidate('company', { managedBy: 'desktop' }), candidate('personal', { managedBy: 'desktop' })],
      restartAndProve: async (target, expectedVersion) => {
        attempted.push(target);
        if (target !== 'personal') throw new Error(`runs 1.0.0 instead of ${expectedVersion}`);
      },
      reportUnownedRestartFailure: () => undefined,
    });

    await expect(plan.restart?.({ expectedVersion: '1.1.0', phase: 'activated' }))
      .rejects.toThrow('default: runs 1.0.0 instead of 1.1.0; company: runs 1.0.0 instead of 1.1.0');
    expect(attempted).toEqual(['default', 'company', 'personal']);
  });

  it('restarts nothing when no service daemon ran, and counts one service once', () => {
    expect(planServiceDaemonsRestartAfterCliUpdate({
      defaultFollowing: candidate('default', { daemonRunning: false }),
      pinned: [],
      restartAndProve: async () => undefined,
      reportUnownedRestartFailure: () => undefined,
    })).toEqual({ labels: [], restart: null });

    expect(planServiceDaemonsRestartAfterCliUpdate({
      defaultFollowing: null,
      pinned: [candidate('company'), candidate('company')],
      restartAndProve: async () => undefined,
      reportUnownedRestartFailure: () => undefined,
    }).labels).toEqual(['company']);
  });
  it('restarts a user-owned pinned service too, but names its failure instead of failing (and rolling back) the update', async () => {
    const attempted: string[] = [];
    const unowned: string[] = [];
    const plan = planServiceDaemonsRestartAfterCliUpdate({
      defaultFollowing: candidate('default'),
      pinned: [
        candidate('user-owned', {
          managedBy: null,
          restartCommand: formatPinnedDaemonServiceRestartCommand({ toolName: 'hprev', serverId: 'company', instanceId: 'company' }),
        }),
        candidate('desktop-owned', { managedBy: 'desktop' }),
      ],
      restartAndProve: async (target, expectedVersion) => {
        attempted.push(target);
        if (target === 'user-owned') throw new Error(`runs 1.0.0 instead of ${expectedVersion}`);
      },
      reportUnownedRestartFailure: (message) => {
        unowned.push(message);
      },
    });

    await expect(plan.restart?.({ expectedVersion: '1.1.0', phase: 'activated' })).resolves.toBeUndefined();
    expect(attempted).toEqual(['default', 'user-owned', 'desktop-owned']);
    // The hint addresses that exact pinned service (not the default-following one `service restart` targets).
    expect(unowned).toEqual([
      'A background service you installed (user-owned) did not come back on 1.1.0 (runs 1.0.0 instead of 1.1.0); the update was kept. Start it with: hprev --server company service restart --instance=company',
    ]);
  });

  it('fails the step only by the services the update owns, still naming a user-owned failure alongside', async () => {
    const unowned: string[] = [];
    const plan = planServiceDaemonsRestartAfterCliUpdate({
      defaultFollowing: candidate('default'),
      pinned: [candidate('user-owned', { managedBy: null })],
      restartAndProve: async (_target, expectedVersion) => {
        throw new Error(`runs 1.0.0 instead of ${expectedVersion}`);
      },
      reportUnownedRestartFailure: (message) => {
        unowned.push(message);
      },
    });

    await expect(plan.restart?.({ expectedVersion: '1.1.0', phase: 'activated' }))
      .rejects.toThrow(/^default: runs 1\.0\.0 instead of 1\.1\.0$/);
    expect(unowned).toEqual([
      'A background service you installed (user-owned) did not come back on 1.1.0 (runs 1.0.0 instead of 1.1.0); the update was kept.',
    ]);
  });
});
