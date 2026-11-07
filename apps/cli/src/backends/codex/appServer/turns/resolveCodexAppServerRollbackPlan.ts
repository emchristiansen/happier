import type { SessionRollbackTarget } from '@happier-dev/protocol';

export type CodexAppServerRollbackEvidenceEntry = Readonly<{
    turnId: string;
    providerTurnId?: string;
    status: 'in_progress' | 'completed' | 'failed' | 'cancelled';
    startedAt: number;
    updatedAt: number;
    terminalAt?: number;
    transcriptAnchors?: Readonly<{
        startUserMessageSeq?: number;
        userMessageSeqs?: readonly number[];
        startSeqInclusive?: number;
        endSeqInclusive?: number | null;
    }>;
    rollback?: Readonly<{
        state?: 'not_eligible' | 'eligible' | 'rolled_back';
        updatedAt?: number;
    }>;
}>;

export type CodexAppServerRollbackEvidenceSet = Readonly<{
    sessionId: string;
    backendId?: string;
    agentId?: string;
    providerThreadId?: string;
    currentTurnId?: string;
    updatedAt: number;
    entries: readonly CodexAppServerRollbackEvidenceEntry[];
    recentMutationIds?: readonly string[];
}>;

export type CodexAppServerRollbackPlan = Readonly<{
    numTurns: number;
    beforeTurnId?: string;
    targetUserMessageSeq: number;
    range: Readonly<{
        startSeqInclusive: number;
        endSeqInclusive: number;
    }>;
}>;

export function buildCodexAppServerRollbackEvidenceSet(
    params: Readonly<CodexAppServerRollbackEvidenceSet>,
): CodexAppServerRollbackEvidenceSet {
    return {
        ...params,
        entries: params.entries.map((entry) => ({
            ...entry,
            ...(entry.transcriptAnchors
                ? {
                    transcriptAnchors: {
                        ...entry.transcriptAnchors,
                        ...(entry.transcriptAnchors.userMessageSeqs
                            ? { userMessageSeqs: [...entry.transcriptAnchors.userMessageSeqs] }
                            : {}),
                    },
                }
                : {}),
            ...(entry.rollback ? { rollback: { ...entry.rollback } } : {}),
        })),
        recentMutationIds: params.recentMutationIds ? [...params.recentMutationIds] : [],
    };
}

function listCompletedRollbackEvidenceEntries(
    sessionTurnEvidence: CodexAppServerRollbackEvidenceSet | null,
): readonly CodexAppServerRollbackEvidenceEntry[] {
    return sessionTurnEvidence?.entries.filter((entry) => (
        entry.status === 'completed'
        && typeof entry.transcriptAnchors?.startUserMessageSeq === 'number'
        && Number.isFinite(entry.transcriptAnchors.startUserMessageSeq)
    )) ?? [];
}

function readRollbackStartSeq(entry: CodexAppServerRollbackEvidenceEntry): number {
    const anchors = entry.transcriptAnchors;
    return typeof anchors?.startSeqInclusive === 'number' && Number.isFinite(anchors.startSeqInclusive)
        ? anchors.startSeqInclusive
        : anchors?.startUserMessageSeq ?? 0;
}

function readRollbackEndSeq(entry: CodexAppServerRollbackEvidenceEntry): number | null {
    const endSeqInclusive = entry.transcriptAnchors?.endSeqInclusive;
    return typeof endSeqInclusive === 'number' && Number.isFinite(endSeqInclusive)
        ? endSeqInclusive
        : null;
}

function readRollbackRangeEndSeq(
    entries: readonly CodexAppServerRollbackEvidenceEntry[],
    targetEntry: CodexAppServerRollbackEvidenceEntry,
): number | null {
    const targetEndSeq = readRollbackEndSeq(targetEntry);
    if (targetEndSeq === null) return null;
    const targetIndex = entries.indexOf(targetEntry);
    return entries.slice(targetIndex + 1).reduce((endSeq, entry) => {
        const anchors = entry.transcriptAnchors;
        const entryEndSeq = readRollbackEndSeq(entry)
            ?? (typeof anchors?.startSeqInclusive === 'number' && Number.isFinite(anchors.startSeqInclusive)
                ? anchors.startSeqInclusive
                : anchors?.startUserMessageSeq);
        return typeof entryEndSeq === 'number' && Number.isFinite(entryEndSeq)
            ? Math.max(endSeq, entryEndSeq)
            : endSeq;
    }, targetEndSeq);
}

export function resolveCodexAppServerRollbackPlan(params: Readonly<{
    target: SessionRollbackTarget;
    sessionTurnEvidence: CodexAppServerRollbackEvidenceSet | null;
    lastObservedMessageSeq?: number | null;
}>): CodexAppServerRollbackPlan | null {
    const allEntries = params.sessionTurnEvidence?.entries ?? [];
    const observedEndSeq = typeof params.lastObservedMessageSeq === 'number'
        && Number.isSafeInteger(params.lastObservedMessageSeq)
        && params.lastObservedMessageSeq >= 0
        ? params.lastObservedMessageSeq
        : null;
    const readRangeEndSeq = (entry: CodexAppServerRollbackEvidenceEntry): number | null => {
        const evidenceEndSeq = readRollbackRangeEndSeq(allEntries, entry);
        return evidenceEndSeq === null || observedEndSeq === null
            ? evidenceEndSeq
            : Math.max(evidenceEndSeq, observedEndSeq);
    };
    const completedEntries = listCompletedRollbackEvidenceEntries(params.sessionTurnEvidence)
        .filter((entry) => entry.rollback?.state === 'eligible');
    if (completedEntries.length === 0) return null;

    if (params.target.type === 'latest_turn') {
        const latest = completedEntries[completedEntries.length - 1];
        const endSeqInclusive = latest ? readRangeEndSeq(latest) : null;
        if (!latest || endSeqInclusive === null) return null;
        return {
            numTurns: 1,
            ...(latest.providerTurnId ? { beforeTurnId: latest.providerTurnId } : {}),
            targetUserMessageSeq: latest.transcriptAnchors?.startUserMessageSeq ?? 0,
            range: {
                startSeqInclusive: readRollbackStartSeq(latest),
                endSeqInclusive,
            },
        };
    }

    const targetUserMessageSeq = params.target.userMessageSeq;
    const targetEntryIndex = completedEntries.findIndex(
        (entry) => entry.transcriptAnchors?.startUserMessageSeq === targetUserMessageSeq,
    );
    if (targetEntryIndex < 0) return null;
    const targetEntry = completedEntries[targetEntryIndex];
    const latest = completedEntries[completedEntries.length - 1];
    const numTurns = completedEntries.length - targetEntryIndex;
    const latestEndSeqInclusive = latest ? readRangeEndSeq(latest) : null;
    if (!targetEntry || !latest || latestEndSeqInclusive === null) return null;

    return {
        numTurns,
        ...(targetEntry.providerTurnId ? { beforeTurnId: targetEntry.providerTurnId } : {}),
        targetUserMessageSeq: targetEntry.transcriptAnchors?.startUserMessageSeq ?? targetUserMessageSeq,
        range: {
            startSeqInclusive: readRollbackStartSeq(targetEntry),
            endSeqInclusive: latestEndSeqInclusive,
        },
    };
}
