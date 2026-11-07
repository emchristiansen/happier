import * as React from 'react';
import { TabBadge } from './TabBadge';
import { resolveGitTabBadge, type GitTabBadge, type TabBarGitBadgeMode } from './tabBadgeModel';
import type { ScmStatus } from '@/sync/domains/state/storageTypes';

type GitActionRailBadgeProps = Readonly<{
    testID?: string;
}> & (
    | Readonly<{ badge: GitTabBadge | null; scmStatus?: never; mode?: never }>
    | Readonly<{ badge?: never; scmStatus: ScmStatus | null | undefined; mode: TabBarGitBadgeMode }>
);

export function GitActionRailBadge(props: GitActionRailBadgeProps) {
    const badge = props.badge === undefined ? resolveGitTabBadge(props.mode, props.scmStatus) : props.badge;
    if (!badge) return null;
    return badge.kind === 'count'
        ? <TabBadge size="compact" variant="count" value={badge.value} tone="neutral" testID={props.testID} />
        : <TabBadge size="compact" variant="diff" added={badge.added} removed={badge.removed} modifiedCount={badge.modifiedCount} testID={props.testID} style={{ flexDirection: 'column', top: -4, left: -9, right: -9 }} />;
}
