import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { findTestInstanceByTypeWithProps, renderScreen } from '@/dev/testkit';
import { installNavigationCommonModuleMocks } from '@/components/ui/navigation/navigationTestHelpers';
import type { ScmStatus } from '@/sync/domains/state/storageTypes';

installNavigationCommonModuleMocks();
const { GitActionRailBadge } = await import('./GitActionRailBadge');
const { formatGitActionRailAccessibilityLabel } = await import('./gitActionRailAccessibility');
const status: ScmStatus = {
    branch: 'main', isDirty: true, modifiedCount: 3, untrackedCount: 0, includedCount: 0,
    lastUpdatedAt: 0, includedLinesAdded: 0, includedLinesRemoved: 0,
    pendingLinesAdded: 42, pendingLinesRemoved: 8, linesAdded: 42, linesRemoved: 8, linesChanged: 50,
};

describe('Git action rail badge', () => {
    it('shows changed files and follows diff/off preferences through the real badge owner', async () => {
        const screen = await renderScreen(<GitActionRailBadge scmStatus={status} mode="changedFiles" testID="git-badge" />);
        expect(screen.findAllHostsByTestId('git-badge')).toHaveLength(1);
        expect(screen.getTextContent()).toBe('3');
        await screen.update(<GitActionRailBadge scmStatus={status} mode="diffLines" testID="git-badge" />);
        expect(screen.getTextContent()).toContain('+42');
        expect(screen.getTextContent()).toContain('−8');
        await screen.update(<GitActionRailBadge scmStatus={status} mode="off" testID="git-badge" />);
        expect(screen.findAllHostsByTestId('git-badge')).toHaveLength(0);
    });
    it('uses file count for incomplete status and hides a clean tree', async () => {
        const screen = await renderScreen(<GitActionRailBadge scmStatus={{ ...status, isComplete: false }} mode="diffLines" testID="git-badge" />);
        expect(screen.getTextContent()).toBe('3');
        await screen.update(<GitActionRailBadge scmStatus={null} mode="changedFiles" testID="git-badge" />);
        expect(screen.findAllHostsByTestId('git-badge')).toHaveLength(0);
    });

    it('keeps compact badge containers open to font-scaled text', async () => {
        const screen = await renderScreen(<GitActionRailBadge scmStatus={status} mode="changedFiles" testID="git-badge" />);
        const badge = screen.findByTestId('git-badge');
        if (!badge) throw new Error('Expected Git badge');
        const styleObjects = (Array.isArray(badge.props.style) ? badge.props.style : [badge.props.style])
            .filter((value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object');
        expect(styleObjects.some((style) => Object.prototype.hasOwnProperty.call(style, 'height'))).toBe(false);
        expect(styleObjects.some((style) => typeof style.minHeight === 'number')).toBe(true);

        const text = findTestInstanceByTypeWithProps(badge, 'Text', {});
        if (!text) throw new Error('Expected badge text');
        expect(text.props.allowFontScaling).not.toBe(false);
    });

    it('describes the visible Git badge on the owning action instead of exposing a decorative nested stop', () => {
        expect(formatGitActionRailAccessibilityLabel({ kind: 'count', value: 1234 }, {
            actionLabel: 'Git',
            changedFilesLabel: 'Changed files',
            diffLinesLabel: 'Added and removed lines',
        })).toBe('Git, Changed files: 1234');
        expect(formatGitActionRailAccessibilityLabel({ kind: 'diff', added: 42, removed: 8, modifiedCount: 3 }, {
            actionLabel: 'Git',
            changedFilesLabel: 'Changed files',
            diffLinesLabel: 'Added and removed lines',
        })).toBe('Git, Added and removed lines: +42, −8');
        expect(formatGitActionRailAccessibilityLabel({ kind: 'diff', added: 0, removed: 0, modifiedCount: 3 }, {
            actionLabel: 'Git',
            changedFilesLabel: 'Changed files',
            diffLinesLabel: 'Added and removed lines',
        })).toBe('Git, Changed files: 3');
        expect(formatGitActionRailAccessibilityLabel(null, {
            actionLabel: 'Git',
            changedFilesLabel: 'Changed files',
            diffLinesLabel: 'Added and removed lines',
        })).toBe('Git');
    });
});
