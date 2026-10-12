import type { IconName } from '@/components/ui/icons/Icon';
import { t } from '@/text';

export type SessionRightTabId = 'git' | 'files' | 'navigation' | 'agents' | 'terminal';

export function getSessionRightPanelTabs(terminalAvailable: boolean, runningAgentCount = 0): ReadonlyArray<{
    id: SessionRightTabId;
    label: string;
    icon: IconName;
    badgeCount?: number;
    accessibilityLabel?: string;
}> {
    return [
        { id: 'git' as const, label: t('session.rightPanel.tabs.git'), icon: 'git-branch' as const },
        { id: 'files' as const, label: t('common.files'), icon: 'folder' as const },
        { id: 'navigation' as const, label: t('session.transcriptNavigation.title'), icon: 'list-bullets' as const },
        {
            id: 'agents' as const,
            label: t('session.subagents.panel.title'),
            icon: 'robot' as const,
            badgeCount: runningAgentCount,
            accessibilityLabel: runningAgentCount > 0
                ? t('session.subagents.panel.tabWithRunningCount', { count: runningAgentCount })
                : undefined,
        },
        ...(terminalAvailable ? [{ id: 'terminal' as const, label: t('settings.terminal'), icon: 'terminal' as const }] : []),
    ];
}
