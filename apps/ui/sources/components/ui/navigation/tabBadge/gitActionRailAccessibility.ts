import { formatBadgeCount, type GitTabBadge } from './tabBadgeModel';

export function formatGitActionRailAccessibilityLabel(
    badge: GitTabBadge | null,
    labels: Readonly<{
        actionLabel: string;
        changedFilesLabel: string;
        diffLinesLabel: string;
    }>,
): string {
    if (!badge) return labels.actionLabel;
    if (badge.kind === 'count') {
        return `${labels.actionLabel}, ${labels.changedFilesLabel}: ${formatBadgeCount(badge.value, Infinity)}`;
    }
    const parts = [
        badge.added > 0 ? `+${formatBadgeCount(badge.added, Infinity)}` : null,
        badge.removed > 0 ? `−${formatBadgeCount(badge.removed, Infinity)}` : null,
    ].filter((part): part is string => part !== null);
    if (parts.length === 0) {
        return `${labels.actionLabel}, ${labels.changedFilesLabel}: ${formatBadgeCount(badge.modifiedCount, Infinity)}`;
    }
    return `${labels.actionLabel}, ${labels.diffLinesLabel}: ${parts.join(', ')}`;
}
