import { describe, expect, it } from 'vitest';

import {
    buildCodexAppServerRollbackEvidenceSet,
    resolveCodexAppServerRollbackPlan,
    type CodexAppServerRollbackEvidenceSet,
} from './resolveCodexAppServerRollbackPlan';

function createSessionTurnEvidence(): CodexAppServerRollbackEvidenceSet {
    return buildCodexAppServerRollbackEvidenceSet({
        sessionId: 'session-1',
        currentTurnId: 'turn-2',
        updatedAt: 30,
        entries: [
            {
                turnId: 'turn-1',
                providerTurnId: 'provider-turn-1',
                status: 'completed',
                startedAt: 1,
                updatedAt: 10,
                terminalAt: 10,
                transcriptAnchors: {
                    startUserMessageSeq: 1,
                    userMessageSeqs: [1],
                    startSeqInclusive: 1,
                    endSeqInclusive: 5,
                },
                rollback: { state: 'rolled_back', updatedAt: 20 },
            },
            {
                turnId: 'turn-2',
                providerTurnId: 'provider-turn-2',
                status: 'completed',
                startedAt: 11,
                updatedAt: 30,
                terminalAt: 30,
                transcriptAnchors: {
                    startUserMessageSeq: 6,
                    userMessageSeqs: [6],
                    startSeqInclusive: 6,
                    endSeqInclusive: 9,
                },
                rollback: { state: 'eligible', updatedAt: 30 },
            },
        ],
        recentMutationIds: ['m1', 'm2'],
    });
}

describe('resolveCodexAppServerRollbackPlan', () => {
    it('does not resolve point rollback from already rolled-back session turn evidence entries', () => {
        expect(resolveCodexAppServerRollbackPlan({
            sessionTurnEvidence: createSessionTurnEvidence(),
            target: { type: 'before_user_message', userMessageSeq: 1 },
        })).toBeNull();
    });

    it('does not resolve rollback from completed entries without eligible SessionTurn evidence', () => {
        expect(resolveCodexAppServerRollbackPlan({
            sessionTurnEvidence: buildCodexAppServerRollbackEvidenceSet({
                sessionId: 'session-1',
                updatedAt: 30,
                entries: [
                    {
                        turnId: 'turn-not-eligible',
                        status: 'completed',
                        startedAt: 1,
                        updatedAt: 10,
                        terminalAt: 10,
                        transcriptAnchors: {
                            startUserMessageSeq: 3,
                            userMessageSeqs: [3],
                            startSeqInclusive: 3,
                            endSeqInclusive: 8,
                        },
                        rollback: { state: 'not_eligible', updatedAt: 10 },
                    },
                ],
                recentMutationIds: [],
            }),
            target: { type: 'before_user_message', userMessageSeq: 3 },
        })).toBeNull();
    });

    it('resolves latest rollback from the latest eligible completed entry', () => {
        expect(resolveCodexAppServerRollbackPlan({
            sessionTurnEvidence: createSessionTurnEvidence(),
            target: { type: 'latest_turn' },
        })).toMatchObject({
            numTurns: 1,
            beforeTurnId: 'provider-turn-2',
            targetUserMessageSeq: 6,
            range: { startSeqInclusive: 6, endSeqInclusive: 9 },
        });
    });

    it('includes a later cancelled turn in the transcript range when reverting before a completed turn', () => {
        const evidence = buildCodexAppServerRollbackEvidenceSet({
            sessionId: 'session-1',
            updatedAt: 30,
            entries: [
                {
                    turnId: 'turn-completed',
                    providerTurnId: 'provider-turn-completed',
                    status: 'completed',
                    startedAt: 1,
                    updatedAt: 10,
                    transcriptAnchors: { startUserMessageSeq: 10, startSeqInclusive: 10, endSeqInclusive: 20 },
                    rollback: { state: 'eligible', updatedAt: 10 },
                },
                {
                    turnId: 'turn-cancelled',
                    providerTurnId: 'provider-turn-cancelled',
                    status: 'cancelled',
                    startedAt: 11,
                    updatedAt: 30,
                    transcriptAnchors: { startUserMessageSeq: 21, startSeqInclusive: 21, endSeqInclusive: null },
                    rollback: { state: 'not_eligible', updatedAt: 30 },
                },
            ],
        });

        expect(resolveCodexAppServerRollbackPlan({
            sessionTurnEvidence: evidence,
            lastObservedMessageSeq: 25,
            target: { type: 'before_user_message', userMessageSeq: 10 },
        })).toMatchObject({
            numTurns: 1,
            beforeTurnId: 'provider-turn-completed',
            range: { startSeqInclusive: 10, endSeqInclusive: 25 },
        });
    });
});
