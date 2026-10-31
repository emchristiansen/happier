import * as React from 'react';
import { Platform, Pressable, View, type AccessibilityActionEvent } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { IconAction } from '@/components/ui/buttons/IconAction';
import {
    SessionListIdentity,
    type SessionListIdentityDisplay,
} from '@/components/sessions/shell/SessionListIdentity';
import { SESSION_LIST_ROW_IDENTITY_METRICS } from '@/components/sessions/shell/sessionListRowDensity';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

export const InboxSessionReviewRow = React.memo(function InboxSessionReviewRow(props: Readonly<{
    session: Session | SessionListRenderableSession;
    identityDisplay: SessionListIdentityDisplay;
    sessionId: string;
    /** Exact Home scope; two Homes may hold the same session id. */
    serverId: string | null;
    title: string;
    subtitle?: string;
    statusLabel: string;
    pending?: boolean;
    showDivider?: boolean;
    onOpen: () => void;
    onMarkRead?: () => Promise<void> | void;
}>) {
    const { theme } = useUnistyles();
    const swipeableRef = React.useRef<Swipeable | null>(null);
    const testIdPrefix = `inbox.review_session.${props.serverId ?? 'local'}.${props.sessionId}`;

    const markRead = React.useCallback(() => {
        if (props.pending || !props.onMarkRead) return;
        swipeableRef.current?.close();
        void props.onMarkRead();
    }, [props.onMarkRead, props.pending]);

    const handleAccessibilityAction = React.useCallback((event: AccessibilityActionEvent) => {
        if (event.nativeEvent.actionName === 'markRead') markRead();
    }, [markRead]);

    const markReadLabel = t('sessionInfo.markSessionRead');

    const row = (
        <Item
            testID={testIdPrefix}
            title={props.title}
            subtitle={props.subtitle}
            density="compact"
            leftElement={props.identityDisplay !== 'none' ? (
                <SessionListIdentity
                    session={props.session}
                    display={props.identityDisplay}
                    avatarSize={SESSION_LIST_ROW_IDENTITY_METRICS.compact.slotSize}
                    agentLogoSize={SESSION_LIST_ROW_IDENTITY_METRICS.compact.agentLogoSize}
                    color={theme.colors.text.primary}
                    testID={`${testIdPrefix}.identity`}
                />
            ) : undefined}
            iconBoxSize={props.identityDisplay !== 'none'
                ? SESSION_LIST_ROW_IDENTITY_METRICS.compact.slotSize
                : undefined}
            accessibilityLabel={`${props.statusLabel}: ${props.title}`}
            onPress={props.onOpen}
            accessibilityState={props.pending ? { busy: true } : undefined}
            accessibilityActions={Platform.OS !== 'web' && props.onMarkRead
                ? (props.pending ? [] : [{ name: 'markRead', label: markReadLabel }])
                : undefined}
            onAccessibilityAction={Platform.OS !== 'web' && props.onMarkRead && !props.pending
                ? handleAccessibilityAction
                : undefined}
            showDivider={props.showDivider}
            // On web the control stays mounted while a mark is in flight: it keeps its
            // role, label, and 44pt target, and reports `busy` instead of vanishing mid-
            // interaction (a replaced control also yanks keyboard focus off the row).
            rightElement={Platform.OS === 'web' && props.onMarkRead ? (
                <IconAction
                    testID={`${testIdPrefix}.mark_read`}
                    accessibilityLabel={markReadLabel}
                    accessibilityRole="button"
                    size="sm"
                    hitSlop={8}
                    disabled={props.pending}
                    accessibilityState={{ busy: props.pending }}
                    onPress={(event) => {
                        event.stopPropagation();
                        markRead();
                    }}
                >
                    {props.pending ? (
                        <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                    ) : (
                        <Icon name="check-circle" size={18} color={theme.colors.text.secondary} />
                    )}
                </IconAction>
            ) : null}
            rightElementOutsidePressable={Platform.OS === 'web' && Boolean(props.onMarkRead)}
            keepChevronWithRightElement
        />
    );

    if (Platform.OS === 'web' || !props.onMarkRead) return row;

    return (
        <Swipeable
            ref={swipeableRef}
            renderRightActions={() => (
                <Pressable
                    testID={`${testIdPrefix}.swipe_mark_read`}
                    accessibilityRole="button"
                    accessibilityLabel={markReadLabel}
                    disabled={props.pending}
                    onPress={markRead}
                    style={({ pressed }) => [
                        styles.swipeAction,
                        pressed ? styles.swipeActionPressed : null,
                        props.pending ? styles.swipeActionPending : null,
                    ]}
                >
                    {props.pending ? (
                        <ActivitySpinner size="small" color={theme.colors.button.primary.tint} />
                    ) : (
                        <Icon name="check-circle" size={20} color={theme.colors.button.primary.tint} />
                    )}
                    <Text style={styles.swipeActionText} numberOfLines={2}>
                        {markReadLabel}
                    </Text>
                </Pressable>
            )}
            overshootRight={false}
            enabled={!props.pending}
        >
            {row}
        </Swipeable>
    );
});

const styles = StyleSheet.create((theme) => ({
    swipeAction: {
        width: 112,
        height: '100%',
        minHeight: 48,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.button.primary.background,
        paddingHorizontal: 12,
    },
    swipeActionPressed: {
        opacity: 0.78,
    },
    swipeActionPending: {
        opacity: 0.56,
    },
    swipeActionText: {
        marginTop: 4,
        fontSize: 12,
        color: theme.colors.button.primary.tint,
        textAlign: 'center',
    },
}));
