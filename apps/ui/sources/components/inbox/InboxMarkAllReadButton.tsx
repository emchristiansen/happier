import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import type { InboxContentModel } from './useInboxContentModel';

export const InboxMarkAllReadButton = React.memo(function InboxMarkAllReadButton(props: Readonly<{
    model: InboxContentModel;
}>) {
    const { theme } = useUnistyles();
    if (props.model.markAllReadTargets.length === 0) return null;
    return (
        <Pressable
            testID="inbox.mark_all_read"
            accessibilityLabel={t('inbox.markAllRead')}
            accessibilityRole="button"
            hitSlop={Platform.select({ ios: 15, default: 17 })}
            disabled={props.model.markAllPending}
            accessibilityState={{ disabled: props.model.markAllPending, busy: props.model.markAllPending }}
            onPress={() => { void props.model.markRead(props.model.markAllReadTargets); }}
            style={({ pressed }) => [styles.labelButton, pressed ? styles.labelButtonPressed : null]}
        >
            {props.model.markAllPending ? (
                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
            ) : (
                <Text style={styles.label}>{t('inbox.markAllRead')}</Text>
            )}
        </Pressable>
    );
});

const styles = StyleSheet.create((theme) => ({
    labelButton: {
        // Match the SelectionList eyebrow's 14pt line box; platform-specific
        // hit slop reaches the 44pt iOS / 48dp Android interaction floor.
        height: 14,
        justifyContent: 'center',
        paddingLeft: 12,
    },
    labelButtonPressed: {
        opacity: 0.62,
    },
    label: {
        fontSize: 12,
        lineHeight: 14,
        color: theme.colors.text.secondary,
        ...Typography.default('semiBold'),
    },
}));
