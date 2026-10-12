import { describe, expect, it } from 'vitest';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { StorageState } from '@/sync/store/types';

import {
    createHasOpenApprovalInboxArtifactSelector,
    resolveInboxHasContent,
} from './useInboxSummary';

describe('resolveInboxHasContent', () => {
    it.each([
        'hasOpenApprovals',
        'hasSessionContent',
        'hasVisibleFriendRequests',
        'hasActionOperationAttention',
    ] as const)('admits the canonical %s attention source', (source) => {
        expect(resolveInboxHasContent({
            hasOpenApprovals: source === 'hasOpenApprovals',
            hasSessionContent: source === 'hasSessionContent',
            hasVisibleFriendRequests: source === 'hasVisibleFriendRequests',
            hasActionOperationAttention: source === 'hasActionOperationAttention',
        })).toBe(true);
    });
});

describe('createHasOpenApprovalInboxArtifactSelector', () => {
    it('reuses the boolean projection across unrelated store waves without rescanning artifacts', () => {
        const artifact = {
            id: 'approval-1',
            draft: false,
            header: {
                kind: 'approval_request.v1',
                approvalStatus: 'open',
            },
        } as unknown as DecryptedArtifact;
        let artifactReads = 0;
        const artifacts = {} as Record<string, DecryptedArtifact>;
        Object.defineProperty(artifacts, artifact.id, {
            enumerable: true,
            get: () => {
                artifactReads += 1;
                return artifact;
            },
        });
        const state = { isDataReady: true, artifacts } as StorageState;
        const selector = createHasOpenApprovalInboxArtifactSelector();

        expect(selector(state)).toBe(true);
        expect(artifactReads).toBe(1);
        expect(selector({ ...state } as StorageState)).toBe(true);
        expect(artifactReads).toBe(1);
    });

    it('excludes draft approvals just like the detailed Inbox artifact source', () => {
        const selector = createHasOpenApprovalInboxArtifactSelector();
        const artifact = {
            id: 'approval-draft',
            draft: true,
            header: {
                kind: 'approval_request.v1',
                approvalStatus: 'open',
            },
        } as unknown as DecryptedArtifact;

        expect(selector({
            isDataReady: true,
            artifacts: { [artifact.id]: artifact },
        } as StorageState)).toBe(false);
    });
});
