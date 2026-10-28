import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ScmStatus } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { formatBadgeCount, formatScmDiffBadge } from './tabBadgeModel';

const styles = StyleSheet.create((theme) => ({
    content: { gap: 4 },
    label: { ...Typography.default(), fontSize: 12, lineHeight: 16, color: theme.colors.text.primary },
    branch: { ...Typography.default(), fontSize: 12, lineHeight: 16, color: theme.colors.text.secondary },
    lines: { flexDirection: 'row', gap: 4 },
    added: { color: theme.colors.versionControl.added.foreground },
    removed: { color: theme.colors.versionControl.removed.foreground },
}));

/** Cached summary only; mounted by the tooltip when hovered or keyboard-focused. */
export function GitActionRailTooltip({ scmStatus }: Readonly<{ scmStatus: ScmStatus | null | undefined }>) {
    const diff = formatScmDiffBadge(scmStatus);
    return (
        <View style={styles.content}>
            <Text style={styles.label}>{scmStatus
                ? `${t('settingsAppearance.tabBarBadges.gitChangedFiles')}: ${formatBadgeCount(diff?.modifiedCount ?? 0, Infinity)}`
                : t('session.rightPanel.tabs.git')}</Text>
            {diff && scmStatus?.isComplete !== false && (diff.added > 0 || diff.removed > 0) ? (
                <View style={styles.lines}>
                    <Text style={[styles.label, styles.added]}>{`+${diff.added}`}</Text>
                    <Text style={[styles.label, styles.removed]}>{`−${diff.removed}`}</Text>
                </View>
            ) : null}
            {(scmStatus?.aheadCount !== undefined || scmStatus?.behindCount !== undefined) ? (
                <View style={styles.lines}>
                    {scmStatus?.aheadCount !== undefined ? <Text style={styles.branch}>{`${t('files.branchSummary.ahead')}: ${formatBadgeCount(scmStatus.aheadCount, Infinity)}`}</Text> : null}
                    {scmStatus?.behindCount !== undefined ? <Text style={styles.branch}>{`${t('files.branchSummary.behind')}: ${formatBadgeCount(scmStatus.behindCount, Infinity)}`}</Text> : null}
                </View>
            ) : null}
            {scmStatus?.branch ? <Text style={styles.branch}>{t('newSession.checkout.detailBranch', { branch: scmStatus.branch })}</Text> : null}
        </View>
    );
}
