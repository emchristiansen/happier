import type {
    DeriveSessionAttentionStateInput,
    SessionAttentionState,
} from './types';

function hasTerminalMaterializedTurnStatus(input: DeriveSessionAttentionStateInput): boolean {
    return input.latestTurnStatus === 'completed'
        || input.latestTurnStatus === 'cancelled'
        || input.latestTurnStatus === 'failed';
}

export function deriveSessionAttentionState(
    input: DeriveSessionAttentionStateInput,
): SessionAttentionState {
    if (input.hasWaitingActivity === true) return 'waiting';
    if (input.latestTurnStatus === 'failed' && input.lastRuntimeIssue != null) return 'failed';
    if (input.isRunning === true) return 'running';
    if (hasTerminalMaterializedTurnStatus(input)) return 'idle';
    if (input.hasReviewActivity === true) return 'review';
    return 'idle';
}
