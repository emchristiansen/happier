import type { DecryptedArtifact } from '../../domains/artifacts/artifactTypes';
import { loadSyncTuning } from '../../runtime/syncTuning';
import type { StoreGet, StoreSet } from './_shared';

const ARTIFACT_HEADS_RETENTION_MAX_COUNT = loadSyncTuning().artifactHeadsRetentionMaxCount;

export type ArtifactsDomain = {
  artifacts: Record<string, DecryptedArtifact>;
  artifactsLoaded: boolean;
  applyArtifacts: (artifacts: DecryptedArtifact[]) => void;
  addArtifact: (artifact: DecryptedArtifact) => void;
  updateArtifact: (artifact: DecryptedArtifact) => void;
  deleteArtifact: (artifactId: string) => void;
};

function compareArtifactsNewestFirst(left: DecryptedArtifact, right: DecryptedArtifact): number {
  if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
  if (right.seq !== left.seq) return right.seq - left.seq;
  if (right.createdAt !== left.createdAt) return right.createdAt - left.createdAt;
  return right.id.localeCompare(left.id);
}

function retainArtifactHeads(
  artifacts: Record<string, DecryptedArtifact>,
): Record<string, DecryptedArtifact> {
  const values = Object.values(artifacts);
  if (values.length <= ARTIFACT_HEADS_RETENTION_MAX_COUNT) return artifacts;
  const retained: Record<string, DecryptedArtifact> = {};
  for (const artifact of values.sort(compareArtifactsNewestFirst).slice(0, ARTIFACT_HEADS_RETENTION_MAX_COUNT)) {
    retained[artifact.id] = artifact;
  }
  return retained;
}

export function createArtifactsDomain<S extends ArtifactsDomain>({
  set,
}: {
  set: StoreSet<S>;
  get: StoreGet<S>;
}): ArtifactsDomain {
  return {
    artifacts: {},
    artifactsLoaded: false,
    applyArtifacts: (artifacts) =>
      set((state) => {
        const mergedArtifacts = { ...state.artifacts };
        artifacts.forEach((artifact) => {
          mergedArtifacts[artifact.id] = artifact;
        });

        return {
          ...state,
          artifacts: retainArtifactHeads(mergedArtifacts),
          artifactsLoaded: true,
        };
      }),
    addArtifact: (artifact) =>
      set((state) => {
        const updatedArtifacts = {
          ...state.artifacts,
          [artifact.id]: artifact,
        };

        return {
          ...state,
          artifacts: retainArtifactHeads(updatedArtifacts),
        };
      }),
    updateArtifact: (artifact) =>
      set((state) => {
        const updatedArtifacts = {
          ...state.artifacts,
          [artifact.id]: artifact,
        };

        return {
          ...state,
          artifacts: retainArtifactHeads(updatedArtifacts),
        };
      }),
    deleteArtifact: (artifactId) =>
      set((state) => {
        const { [artifactId]: _, ...remainingArtifacts } = state.artifacts;

        return {
          ...state,
          artifacts: remainingArtifacts,
        };
      }),
  };
}
