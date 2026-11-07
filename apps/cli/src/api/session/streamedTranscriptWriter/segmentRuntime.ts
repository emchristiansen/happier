import type { StreamedTranscriptSegmentKey, StreamedTranscriptSegmentKind } from './segmentKey';
import type { LiveDeliveryState } from './liveDeliveryState';
import type { SessionTranscriptObservationProvenanceV1 } from '@happier-dev/protocol';
import type { SessionMessageCommitResult } from '../sessionMessageCommitResult';

export type DurableCommitFailureIncident = {
  firstError: Record<string, unknown>;
  count: number;
  suppressedCount: number;
};

export type StreamedTranscriptSegmentState = 'streaming' | 'complete' | 'interrupted';

export type StreamedTranscriptSegmentRuntime = {
  key: StreamedTranscriptSegmentKey;
  kind: StreamedTranscriptSegmentKind;
  sidechainId: string | null;
  segmentLocalId: string;
  commitMode: 'compatibility' | 'exact';
  startedAtMs: number;
  accumulatedText: string;
  textVersion: number;
  didWriteDurable: boolean;
  appendOnlySinceLastDurableSnapshot: boolean;
  lastDurableText: string;
  lastCheckpointAtMs: number;
  lastCheckpointTextLen: number;
  lastCommittedTextVersion: number;
  lastCommittedState: StreamedTranscriptSegmentState | null;
  lastCommitFailedAtMs: number;
  lastCommitError: unknown | null;
  lastCommitResult: SessionMessageCommitResult | null;
  durableCommitFailure: DurableCommitFailureIncident | null;
  durableRetryNotBeforeMs: number;
  liveDelivery: LiveDeliveryState;
  additionalMeta: Record<string, unknown>;
  provenance?: SessionTranscriptObservationProvenanceV1;
  durableCheckpointTimer: ReturnType<typeof setTimeout> | null;
  liveSnapshotTimer: ReturnType<typeof setTimeout> | null;
  isCommittingDurable: boolean;
  pendingDurableCommit: { state: StreamedTranscriptSegmentState; interruptedReason?: string } | null;
  idleWaiters: Array<() => void>;
};

export function waitForSegmentDrain(segment: StreamedTranscriptSegmentRuntime): Promise<void> {
  if (!segment.isCommittingDurable && !segment.pendingDurableCommit) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    segment.idleWaiters.push(resolve);
  });
}
