import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createSessionScmReviewDetailsTab, SESSION_DETAILS_SCM_REVIEW_TAB_KEY } from './details/sessionDetailsTabBuilders';

export function selectSessionRightTab(pane: Pick<AppPaneScopeApi, 'scopeState' | 'openRight' | 'closeRight' | 'closeDetails'>, tabId: string, rightPaneHiddenByDetails = false) {
    if (rightPaneHiddenByDetails) {
        pane.closeDetails();
        pane.openRight({ tabId });
        return;
    }
    if (pane.scopeState?.right.isOpen && (pane.scopeState.right.activeTabId ?? 'git') === tabId) {
        pane.closeRight();
    } else {
        pane.openRight({ tabId });
    }
}

export function toggleSessionReview(pane: Pick<AppPaneScopeApi, 'scopeState' | 'openDetailsTab' | 'closeDetails'>) {
    if (pane.scopeState?.details.isOpen && pane.scopeState.details.activeTabKey === SESSION_DETAILS_SCM_REVIEW_TAB_KEY) {
        pane.closeDetails();
    } else {
        pane.openDetailsTab(createSessionScmReviewDetailsTab(), { intent: 'pinned' });
    }
}
