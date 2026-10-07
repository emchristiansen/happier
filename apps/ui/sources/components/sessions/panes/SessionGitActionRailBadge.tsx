import * as React from 'react';
import { useSessionProjectScmStatus, useSetting } from '@/sync/domains/state/storage';
import { GitActionRailTooltip } from '@/components/ui/navigation/tabBadge/GitActionRailTooltip';
import { GitActionRailBadge } from '@/components/ui/navigation/tabBadge/GitActionRailBadge';
import { resolveGitTabBadge, type GitTabBadge } from '@/components/ui/navigation/tabBadge/tabBadgeModel';

// Keep SCM updates local to the badge, as in the mobile cockpit's canonical badge model.
export function useSessionGitActionRailBadge(sessionId: string): GitTabBadge | null {
    const scmStatus = useSessionProjectScmStatus(sessionId);
    const mode = useSetting('tabBarGitBadgeMode');
    return resolveGitTabBadge(mode, scmStatus);
}

export const SessionGitActionRailBadge = React.memo((props: Readonly<{ badge: GitTabBadge | null }>) => {
    return <GitActionRailBadge badge={props.badge} testID="session-action-rail:git:badge" />;
});

export function SessionGitActionRailTooltip(props: Readonly<{ sessionId: string }>) {
    const scmStatus = useSessionProjectScmStatus(props.sessionId);
    return <GitActionRailTooltip scmStatus={scmStatus} />;
}
