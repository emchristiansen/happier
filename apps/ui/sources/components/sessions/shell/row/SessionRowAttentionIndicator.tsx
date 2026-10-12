import React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

import { StatusDot } from '@/components/ui/status/StatusDot';
import type {
    SessionRowAttentionIndicator as SessionRowAttentionIndicatorKind,
    SessionRowAttentionState,
} from './resolveSessionRowPresentation';
import { resolveSessionRowAttentionIndicatorColor } from './sessionRowAttentionColors';

/** Fills the indicator's 16 px slot, so the working mark reads at the scale of the row's agent icons. */
const DEFAULT_WORKING_SPINNER_SIZE = 16;

const stylesheet = StyleSheet.create(() => ({
    container: {
        width: 16,
        height: 16,
        alignItems: 'center',
        justifyContent: 'center',
    },
    stateContainer: {
        width: 16,
        height: 16,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

export const SessionRowAttentionIndicator = React.memo(function SessionRowAttentionIndicator(props: Readonly<{
    indicator: SessionRowAttentionIndicatorKind;
    sessionId: string;
    attentionState: SessionRowAttentionState;
    accessibilityLabel?: string;
    workingMode?: 'spinner' | 'pulse';
    workingSpinnerTone?: 'info' | 'neutral';
    animationEnabled?: boolean;
}>) {
    const { theme } = useUnistyles();

    if (props.indicator === 'none') {
        return null;
    }

    const color = resolveSessionRowAttentionIndicatorColor({
        indicator: props.indicator,
        theme,
        workingMode: props.workingMode,
        workingSpinnerTone: props.workingSpinnerTone,
    });

    const shouldRenderWorkingSpinner = props.indicator === 'working'
        && props.workingMode !== 'pulse';
    const shouldPulse = props.indicator === 'permission'
        || props.indicator === 'action'
        || props.indicator === 'failed'
        || (props.indicator === 'working' && props.workingMode === 'pulse');

    return (
        <View
            testID={`session-row-attention-indicator-${props.sessionId}`}
            accessibilityLabel={props.accessibilityLabel}
            accessibilityRole={props.accessibilityLabel ? 'image' : undefined}
            style={stylesheet.container}
        >
            <View
                testID={`session-list-attention-indicator-${props.sessionId}-${props.attentionState}`}
                style={stylesheet.stateContainer}
            >
                {shouldRenderWorkingSpinner ? (
                    <ActivitySpinner
                        testID={`session-row-attention-indicator-spinner-${props.sessionId}`}
                        size={DEFAULT_WORKING_SPINNER_SIZE}
                        color={color}
                        animationEnabled={props.animationEnabled !== false}
                    />
                ) : (
                    <StatusDot
                        testID={`session-row-attention-indicator-dot-${props.sessionId}`}
                        color={color}
                        isPulsing={shouldPulse}
                        size={props.indicator === 'permission' || props.indicator === 'action' || props.indicator === 'failed' ? 7 : 6}
                        animationEnabled={props.animationEnabled !== false}
                    />
                )}
            </View>
        </View>
    );
});
