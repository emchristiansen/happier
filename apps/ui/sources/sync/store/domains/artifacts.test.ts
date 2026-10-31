import { describe, expect, it } from 'vitest';

import { loadSyncTuning } from '@/sync/runtime/syncTuning';

import type { DecryptedArtifact } from '../../domains/artifacts/artifactTypes';
import { createArtifactsDomain } from './artifacts';

type State = ReturnType<typeof createArtifactsDomain>;

function createHarness(): { get: () => State } {
  let state = {} as State;
  const get = () => state;
  const set = (updater: (state: State) => State) => {
    state = updater(state);
  };
  state = createArtifactsDomain({ get, set } as any);
  return { get };
}

function artifact(index: number): DecryptedArtifact {
  return {
    id: `artifact_${index}`,
    title: `Artifact ${index}`,
    headerVersion: 1,
    seq: index,
    createdAt: index,
    updatedAt: index,
    isDecrypted: true,
  };
}

describe('createArtifactsDomain', () => {
  it('marks artifacts loaded only after a snapshot is applied', () => {
    const harness = createHarness();
    expect(harness.get().artifactsLoaded).toBe(false);

    harness.get().applyArtifacts([]);
    expect(harness.get().artifactsLoaded).toBe(true);
  });

  it('retains only the newest configured artifact heads', () => {
    const cap = (loadSyncTuning() as { artifactHeadsRetentionMaxCount?: number }).artifactHeadsRetentionMaxCount ?? 1000;
    const harness = createHarness();

    harness.get().applyArtifacts(Array.from({ length: cap + 2 }, (_, index) => artifact(index + 1)));

    expect(Object.keys(harness.get().artifacts)).toHaveLength(cap);
    expect(harness.get().artifacts.artifact_1).toBeUndefined();
    expect(harness.get().artifacts.artifact_2).toBeUndefined();
    expect(harness.get().artifacts[`artifact_${cap + 2}`]).toBeTruthy();
  });
});
