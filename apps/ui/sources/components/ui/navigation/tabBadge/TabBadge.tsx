import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { formatBadgeCount } from './tabBadgeModel';

const styles = StyleSheet.create((theme) => ({
    countBadge: {
        position: 'absolute',
        top: -3,
        right: -8,
        backgroundColor: theme.colors.status.error,
        borderRadius: 999,
        minWidth: 13,
        minHeight: 13,
        paddingHorizontal: 3,
        justifyContent: 'center',
        alignItems: 'center',
    },
    countBadgeCompact: {
        minWidth: 8,
        minHeight: 8,
        paddingHorizontal: 2,
        right: -6,
    },
    compactText: {
        fontSize: 7,
        lineHeight: 8,
    },
    diffChipCompact: {
        minHeight: 8,
        paddingHorizontal: 2,
        gap: 1,
    },
    countBadgeNeutral: {
        backgroundColor: theme.colors.accent.blue,
    },
    countBadgeNeutralCompact: {
        backgroundColor: theme.colors.surface.elevated,
    },
    countTextNeutralCompact: {
        color: theme.colors.text.secondary,
    },
    countText: {
        color: theme.colors.button.primary.tint,
        fontSize: 8,
        fontVariant: ['tabular-nums'],
        ...Typography.default('semiBold'),
    },
    dot: {
        position: 'absolute',
        top: 0,
        right: -2,
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.text.primary,
    },
    diffChip: {
        position: 'absolute',
        top: -4,
        right: -11,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        minHeight: 12,
        paddingHorizontal: 3,
        borderRadius: 999,
        backgroundColor: theme.colors.surface.base,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    diffAdded: {
        color: theme.colors.versionControl.added.foreground,
        fontSize: 8,
        lineHeight: 11,
        fontVariant: ['tabular-nums'],
        ...Typography.default('semiBold'),
    },
    diffRemoved: {
        color: theme.colors.versionControl.removed.foreground,
        fontSize: 8,
        lineHeight: 11,
        fontVariant: ['tabular-nums'],
        ...Typography.default('semiBold'),
    },
    diffModified: {
        color: theme.colors.text.secondary,
        fontSize: 8,
        lineHeight: 11,
        fontVariant: ['tabular-nums'],
        ...Typography.default('semiBold'),
    },
}));

/**
 * What a count means, not what colour it is.
 *
 * `'alert'` is the default and stays red: something is wrong or waiting. `'neutral'` is for a count
 * that is merely informative — work in progress is not a problem, and painting it red spends the
 * one colour reserved for "a person is needed" on something that needs nobody.
 */
export type TabBadgeCountTone = 'alert' | 'neutral';

type TabBadgeProps =
    | Readonly<{ variant: 'dot'; style?: StyleProp<ViewStyle>; testID?: string }>
    | Readonly<{
        variant: 'count';
        size?: 'default' | 'compact';
        value: number;
        max?: number;
        tone?: TabBadgeCountTone;
        style?: StyleProp<ViewStyle>;
        testID?: string;
    }>
    | Readonly<{
        variant: 'diff';
        size?: 'default' | 'compact';
        added: number;
        removed: number;
        modifiedCount: number;
        max?: number;
        style?: StyleProp<ViewStyle>;
        testID?: string;
    }>;

/**
 * Unified tab-bar badge. Replaces the per-bar inline badge/indicator markup so
 * counts, dots, and git diff chips share spacing, capping, and theme tokens.
 */
export function TabBadge(props: TabBadgeProps): React.ReactElement {
    if (props.variant === 'dot') {
        return <View testID={props.testID} style={props.style ? [styles.dot, props.style] : styles.dot} />;
    }

    if (props.variant === 'count') {
        return (
            <View
                testID={props.testID}
                style={[
                    styles.countBadge,
                    props.size === 'compact' ? styles.countBadgeCompact : null,
                    props.tone === 'neutral' ? (props.size === 'compact' ? styles.countBadgeNeutralCompact : styles.countBadgeNeutral) : null,
                    props.style ?? null,
                ]}
            >
                <Text style={[styles.countText, props.size === 'compact' ? styles.compactText : null, props.size === 'compact' && props.tone === 'neutral' ? styles.countTextNeutralCompact : null]}>{formatBadgeCount(props.value, props.max)}</Text>
            </View>
        );
    }

    const max = props.max ?? 999;
    const showLines = props.added > 0 || props.removed > 0;
    return (
        <View testID={props.testID} style={[styles.diffChip, props.size === 'compact' ? styles.diffChipCompact : null, props.style]}>
            {showLines ? (
                <>
                    {props.added > 0 ? (
                        <Text style={[styles.diffAdded, props.size === 'compact' ? styles.compactText : null]}>{`+${formatBadgeCount(props.added, max)}`}</Text>
                    ) : null}
                    {props.removed > 0 ? (
                        <Text style={[styles.diffRemoved, props.size === 'compact' ? styles.compactText : null]}>{`−${formatBadgeCount(props.removed, max)}`}</Text>
                    ) : null}
                </>
            ) : (
                <Text style={[styles.diffModified, props.size === 'compact' ? styles.compactText : null]}>{formatBadgeCount(props.modifiedCount, max)}</Text>
            )}
        </View>
    );
}
