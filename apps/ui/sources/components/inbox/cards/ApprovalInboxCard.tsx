import * as React from 'react';
import { getActionSpec, type ActionId } from '@happier-dev/protocol';
import { useUnistyles } from 'react-native-unistyles';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';

export const ApprovalInboxCard = React.memo((props: Readonly<{
  artifact: DecryptedArtifact;
  sessionContext?: Readonly<{
    sessionTitle: string;
    machineLabel: string | null;
    workspaceName: string | null;
  }> | null;
  onPress: () => void;
  showDivider?: boolean;
  density?: 'comfortable' | 'cozy' | 'compact' | 'tight';
}>): React.ReactElement => {
  const { theme } = useUnistyles();

  const title = props.artifact.header?.title ?? props.artifact.title ?? t('approvals.untitled');
  const actionIdRaw = typeof props.artifact.header?.actionId === 'string' ? String(props.artifact.header.actionId).trim() : '';

  const actionTitle = React.useMemo(() => {
    if (!actionIdRaw) return null;
    try {
      return getActionSpec(actionIdRaw as ActionId).title;
    } catch {
      return actionIdRaw;
    }
  }, [actionIdRaw]);

  const subtitle = [
    actionTitle,
    props.sessionContext?.sessionTitle,
    props.sessionContext?.machineLabel,
    props.sessionContext?.workspaceName,
  ].filter(Boolean).join('\n');

  return (
    <Item
      testID={`inbox.approval.${props.artifact.id}`}
      title={title}
      subtitle={subtitle || undefined}
      subtitleLines={4}
      density={props.density ?? 'compact'}
      icon={<Icon name="warning-circle" size={18} color={theme.colors.status.error} />}
      onPress={props.onPress}
      showDivider={props.showDivider}
    />
  );
});

ApprovalInboxCard.displayName = 'ApprovalInboxCard';
