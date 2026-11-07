import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { HorizontalOverflowScrollView } from '@/components/ui/scroll/HorizontalOverflowScrollView';
import { Text } from '@/components/ui/text/Text';
import { CopyIconButton } from '@/components/ui/copy/CopyIconButton';

export type CodeBlockViewFrameProps = Readonly<{
    code: string;
    language?: string | null;
    selectable?: boolean;
    wrap?: boolean;
    showCopyButton?: boolean;
    headerRight?: React.ReactNode;
    scrollTestID?: string;
    children: React.ReactNode;
}>;

export const CodeBlockViewFrame = React.memo<CodeBlockViewFrameProps>(({
    code,
    language = null,
    selectable = true,
    wrap = false,
    showCopyButton = false,
    headerRight,
    scrollTestID,
    children,
}) => {
    const { theme } = useUnistyles();
    const shouldRenderHeaderRow = Boolean(language) || Boolean(headerRight);
    const shouldOverlayCopyButton = showCopyButton && !shouldRenderHeaderRow;
    const contentPaddingStyle = shouldOverlayCopyButton ? [styles.codePadding, styles.codePaddingOverlay] : styles.codePadding;

    const copyButton = showCopyButton ? (
        <CopyIconButton
            text={code}
            style={shouldOverlayCopyButton ? styles.copyButtonOverlay : undefined}
        />
    ) : null;

    const header = shouldRenderHeaderRow ? (
        <View style={styles.headerRow}>
            {language ? (
                <Text selectable={selectable} style={[styles.headerText, { color: theme.colors.text.secondary }]}>
                    {language}
                </Text>
            ) : (
                <View />
            )}
            <View style={styles.headerRight}>
                {headerRight}
                {copyButton}
            </View>
        </View>
    ) : null;

    return (
        <View
            style={[
                styles.container,
                { backgroundColor: theme.colors.surface.inset, borderColor: theme.colors.border.default },
            ]}
        >
            {header}
            {shouldOverlayCopyButton ? copyButton : null}
            {wrap ? (
                <View style={contentPaddingStyle}>
                    {children}
                </View>
            ) : (
                <HorizontalOverflowScrollView
                    testID={scrollTestID}
                    keepNativeTextSelection={!showCopyButton}
                    showsHorizontalScrollIndicator={false}
                    style={styles.scroll}
                    contentContainerStyle={contentPaddingStyle}
                >
                    {children}
                </HorizontalOverflowScrollView>
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        alignSelf: 'stretch',
        borderRadius: 10,
        borderWidth: 1,
        overflow: 'hidden',
        position: 'relative',
    },
    scroll: {
        width: '100%',
        alignSelf: 'stretch',
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 12,
        paddingVertical: 10,
    },
    headerText: {
        ...Typography.mono(),
        fontSize: 12,
    },
    headerRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    copyButtonOverlay: {
        position: 'absolute',
        top: 8,
        right: 8,
        zIndex: 10,
        borderWidth: 1,
        backgroundColor: theme.colors.surface.elevated,
        borderColor: theme.colors.border.default,
    },
    codePadding: {
        paddingHorizontal: 12,
        paddingVertical: 12,
    },
    codePaddingOverlay: {
        paddingTop: 18,
    },
}));
