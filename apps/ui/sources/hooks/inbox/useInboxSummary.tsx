import * as React from 'react';

import { isOpenApprovalInboxArtifact } from '@/sync/domains/artifacts/approvalArtifacts';
import { useInboxActionOperationSummary } from '@/sync/domains/actionOperations/useActionOperations';
import { useActiveServerAccountScope, useFriendRequestCount } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import type { StorageState } from '@/sync/store/types';

import { useInboxSessionSummary } from './useInboxSessionState';
import { useInboxFriendRequestsVisible } from './useInboxFriendRequests';

export type InboxSummary = Readonly<{
    hasContent: boolean;
}>;

export function resolveInboxHasContent(input: Readonly<{
    hasOpenApprovals: boolean;
    hasSessionContent: boolean;
    hasVisibleFriendRequests: boolean;
    hasActionOperationAttention: boolean;
}>): boolean {
    return input.hasOpenApprovals
        || input.hasSessionContent
        || input.hasVisibleFriendRequests
        || input.hasActionOperationAttention;
}

export function createHasOpenApprovalInboxArtifactSelector(): (state: StorageState) => boolean {
    let previousArtifacts: StorageState['artifacts'] | null = null;
    let previousIsDataReady = false;
    let previous = false;

    return (state) => {
        if (state.artifacts === previousArtifacts && state.isDataReady === previousIsDataReady) {
            return previous;
        }
        previousArtifacts = state.artifacts;
        previousIsDataReady = state.isDataReady;
        previous = state.isDataReady && Object.values(state.artifacts).some((artifact) => (
            artifact.draft !== true && isOpenApprovalInboxArtifact(artifact)
        ));
        return previous;
    };
}

const selectHasOpenApprovalInboxArtifact = createHasOpenApprovalInboxArtifactSelector();

export function useInboxSummary(): InboxSummary {
    const accountId = useActiveServerAccountScope()?.accountId ?? '';
    const hasOpenApproval = storage(selectHasOpenApprovalInboxArtifact);
    const friendRequestsVisible = useInboxFriendRequestsVisible();
    const friendRequestCount = useFriendRequestCount();
    const sessionSummary = useInboxSessionSummary();
    const actionOperationSummary = useInboxActionOperationSummary(accountId);
    const hasVisibleFriendRequest = friendRequestsVisible && friendRequestCount > 0;
    const hasContent = resolveInboxHasContent({
        hasOpenApprovals: hasOpenApproval,
        hasSessionContent: sessionSummary.hasContent,
        hasVisibleFriendRequests: hasVisibleFriendRequest,
        hasActionOperationAttention: actionOperationSummary.hasAttention,
    });

    return React.useMemo(() => ({ hasContent }), [hasContent]);
}

const InboxSummaryContext = React.createContext<InboxSummary | null>(null);

export function InboxSummaryProvider(props: Readonly<{
    summary: InboxSummary;
    children: React.ReactNode;
}>) {
    return React.createElement(InboxSummaryContext.Provider, { value: props.summary }, props.children);
}

export function useSharedInboxSummary(): InboxSummary {
    const summary = React.useContext(InboxSummaryContext);
    if (!summary) throw new Error('InboxSummaryProvider is required');
    return summary;
}
