import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withConnectedServiceStateSharingDestinationLock } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingLock';

import { resolveClaudeRuntimeProviderAccountIdentity } from './resolveClaudeRuntimeProviderAccountIdentity';

const tuple = { groupId: 'team-pool', activeProfileId: 'a', generation: 4, credentialRevision: null };

describe('group account snapshot deadline', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'snapshot-deadline-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('settles unproven within its bound while an in-process writer holds the home lock', async () => {
    let releaseWriter!: () => void;
    const writerHeld = new Promise<void>((resolve) => { releaseWriter = resolve; });
    let writerEntered!: () => void;
    const entered = new Promise<void>((resolve) => { writerEntered = resolve; });
    // The in-process queue ahead of the file lock is what the file lock's own acquire timeout misses.
    const writer = withConnectedServiceStateSharingDestinationLock(home, async () => {
      writerEntered();
      await writerHeld;
    }, { providerId: 'claude' });
    await entered;
    try {
      const startedAt = performance.now();
      const identity = await resolveClaudeRuntimeProviderAccountIdentity({
        env: { CLAUDE_CONFIG_DIR: home },
        groupSelection: tuple,
      });
      const elapsedMs = performance.now() - startedAt;
      expect(identity).toEqual({ providerAccountId: null, providerEmail: null, providerOrganizationId: null });
      expect(elapsedMs).toBeLessThan(2_800);
    } finally {
      releaseWriter();
      await writer;
    }
  }, 10_000);
});
