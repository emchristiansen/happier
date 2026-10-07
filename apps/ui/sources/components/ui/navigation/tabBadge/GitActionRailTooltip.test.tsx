import * as React from 'react';
import { expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installNavigationCommonModuleMocks } from '@/components/ui/navigation/navigationTestHelpers';
import type { ScmStatus } from '@/sync/domains/state/storageTypes';
installNavigationCommonModuleMocks({
    text: async () => ({ t: (key: string, params?: { branch?: string }) => params?.branch ? `${key}: ${params.branch}` : key }),
});
const { GitActionRailTooltip } = await import('./GitActionRailTooltip');

const status: ScmStatus = {
    branch: 'feature/rail', isDirty: true, modifiedCount: 1234, untrackedCount: 0, includedCount: 0,
    lastUpdatedAt: 0, includedLinesAdded: 0, includedLinesRemoved: 0,
    pendingLinesAdded: 7836, pendingLinesRemoved: 1398, linesAdded: 7836, linesRemoved: 1398, linesChanged: 9234,
};
it('shows uncapped file and line totals with the branch from the cached summary', async () => {
    const screen = await renderScreen(<GitActionRailTooltip scmStatus={status} />);
    const text = screen.getTextContent();
    expect(text).toContain('1234');
    expect(text).toContain('+7836');
    expect(text).toContain('−1398');
    expect(text).toContain('feature/rail');
    expect(text).not.toContain('99+');
});
it('does not present partial line totals as complete or invent a missing branch', async () => {
    const screen = await renderScreen(<GitActionRailTooltip scmStatus={{ ...status, branch: null, isComplete: false }} />);
    expect(screen.getTextContent()).toContain('1234');
    expect(screen.getTextContent()).not.toContain('+7836');
    expect(screen.getTextContent()).not.toContain('feature/rail');
    await screen.update(<GitActionRailTooltip scmStatus={null} />);
    expect(screen.getTextContent()).not.toContain('1234');
});

it('shows available upstream divergence and omits unknown tracking counts', async () => {
    const screen = await renderScreen(<GitActionRailTooltip scmStatus={{ ...status, aheadCount: 12, behindCount: 3 }} />);
    expect(screen.getTextContent()).toContain('files.branchSummary.ahead: 12');
    expect(screen.getTextContent()).toContain('files.branchSummary.behind: 3');
    await screen.update(<GitActionRailTooltip scmStatus={status} />);
    expect(screen.getTextContent()).not.toContain('files.branchSummary.ahead');
    expect(screen.getTextContent()).not.toContain('files.branchSummary.behind');
});
