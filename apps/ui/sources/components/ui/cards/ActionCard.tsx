import * as React from 'react';
import { View, ViewStyle, StyleProp } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

export interface ActionCardProps {
    title: string;
    description?: string;
    primaryAction: { label: string; onPress: () => void | Promise<void> };
    secondaryAction?: { label: string; onPress: () => void };
    icon?: React.ReactNode;
    loading?: boolean;
    disabled?: boolean;
    testID?: string;
    style?: StyleProp<ViewStyle>;
    /** A quiet, setup-like presentation for contextual recovery actions. */
    appearance?: 'default' | 'quiet';
}

export const ActionCard = React.memo<ActionCardProps>(
    ({ title, description, primaryAction, secondaryAction, icon, loading, disabled, testID, style, appearance = 'default' }) => {
        const { theme } = useUnistyles();
        const styles = stylesheet;
        const quiet = appearance === 'quiet';

        return (
            <View
                testID={testID}
                style={[
                    styles.container,
                    {
                        backgroundColor: quiet ? 'transparent' : theme.colors.surface.inset,
                        borderColor: quiet ? 'transparent' : theme.colors.border.default,
                    },
                    quiet ? styles.quietContainer : null,
                    style,
                ]}
            >
                {icon ? <View style={[styles.iconRow, quiet ? styles.quietIconRow : null]}>{icon}</View> : null}
                <Text style={[styles.title, quiet ? styles.quietTitle : null, { color: theme.colors.text.primary }]}>{title}</Text>
                {description ? (
                    <Text style={[styles.description, quiet ? styles.quietDescription : null, { color: theme.colors.text.secondary }]}>
                        {description}
                    </Text>
                ) : null}
                <View style={[styles.buttonRow, quiet ? styles.quietButtonRow : null]}>
                    <RoundButton
                        title={primaryAction.label}
                        titleNumberOfLines="complete"
                        style={[styles.button, quiet ? styles.quietButton : null]}
                        size={quiet ? 'normal' : undefined}
                        loading={loading}
                        onPress={loading ? undefined : primaryAction.onPress}
                        disabled={disabled || loading}
                        testID={testID ? `${testID}-primary` : undefined}
                    />
                    {secondaryAction ? (
                        <RoundButton
                            title={secondaryAction.label}
                            titleNumberOfLines="complete"
                            style={[styles.button, quiet ? styles.quietButton : null]}
                            size={quiet ? 'normal' : undefined}
                            display="inverted"
                            loading={loading}
                            onPress={secondaryAction.onPress}
                            disabled={disabled || loading}
                            testID={testID ? `${testID}-secondary` : undefined}
                        />
                    ) : null}
                </View>
            </View>
        );
    },
);

const stylesheet = StyleSheet.create(() => ({
    container: {
        borderRadius: 12,
        padding: 16,
        borderWidth: 1,
    },
    quietContainer: {
        alignSelf: 'center',
        alignItems: 'center',
        width: '100%',
        maxWidth: 560,
        padding: 0,
        borderRadius: 0,
        borderWidth: 0,
    },
    iconRow: {
        marginBottom: 12,
    },
    quietIconRow: {
        alignItems: 'center',
        marginBottom: 18,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 16,
        lineHeight: 22,
    },
    quietTitle: {
        width: '100%',
        textAlign: 'center',
        fontSize: 22,
        lineHeight: 28,
        letterSpacing: -0.25,
    },
    description: {
        ...Typography.default('regular'),
        fontSize: 14,
        lineHeight: 20,
        marginTop: 4,
    },
    quietDescription: {
        width: '100%',
        maxWidth: 520,
        textAlign: 'center',
        fontSize: 15,
        lineHeight: 22,
        marginTop: 8,
    },
    buttonRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 12,
        marginTop: 16,
    },
    button: {
        maxWidth: '100%',
    },
    quietButtonRow: {
        width: '100%',
        justifyContent: 'center',
        alignItems: 'center',
        marginTop: 24,
    },
    quietButton: {
        alignSelf: 'center',
        flexGrow: 0,
        flexShrink: 1,
    },
}));
