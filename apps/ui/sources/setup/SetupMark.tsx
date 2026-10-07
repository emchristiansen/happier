import * as React from 'react';
import { View } from 'react-native';
import Animated, {
    Easing,
    cancelAnimation,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Circle, Svg } from 'react-native-svg';

import { ICON_CIRCLE_INK_RATIO } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { resolveMotionPresentation } from '@/components/ui/motion/reducedMotionTable';
import { StatusTransition } from '@/components/ui/motion/StatusTransition';
import { CapacityRing } from '@/components/ui/progress/CapacityRing';
import { useIsHostVisible } from '@/hooks/ui/useIsHostVisible';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import type { SetupStageId, SetupSurfacePhase } from './setupStageModel';

/**
 * The setup surface's one mark: a 64 pt `CapacityRing` filled by milestone, a stage glyph settling
 * in its centre, and — while a stage is in progress — a short highlight travelling the part of the
 * track that is still to come. That highlight is the surface's only moving object. It implies no
 * fraction (it is not the arc and never fills), and it is the row `setupActivity` in the
 * reduced-motion table: under reduced motion it is replaced by a static tint on the track.
 *
 * Sweeping only the remaining track is what keeps it readable: drawn across the completed arc it
 * is the same ink at a third of the strength, so it disappeared for exactly as much of each lap as
 * the arc covered. Starting where the arc ends — a sixth of the remainder long, over that share of
 * the lap — keeps one object at one speed and says "this much is done, this part is working".
 *
 * Composition only. `CapacityRing`, `StatusTransition` and `Icon` know nothing about setup; the
 * fraction, the glyph and the transition key all arrive from `setupStageModel`.
 *
 * The highlight is a long-running status animation, so it declares its stop condition: reduced
 * motion replaces it with a static tint, a non-working phase removes it, and a hidden window stops
 * it turning. It never runs unseen.
 */

const RING_PX = 64;
const RING_STROKE_PX = 2;
const GLYPH_PX = ICON_SIZE.lg;

/** One lap of the WHOLE track. Slow enough to read as patience rather than urgency. */
const HIGHLIGHT_LAP_MS = 1800;
/** The highlight covers a sixth of the track it sweeps — 60° when nothing is complete yet. */
const HIGHLIGHT_ARC_FRACTION = 1 / 6;
const HIGHLIGHT_OPACITY = 0.32;
const FULL_TURN_DEG = 360;

const STAGE_GLYPHS = {
    prepare: 'download',
    connect: 'link',
    service: 'gear',
    verify: 'shield-check',
} as const satisfies Record<SetupStageId, IconName>;

const PHASE_GLYPHS = {
    checking: 'desktop',
    blocked: 'warning-circle',
} as const satisfies Record<Exclude<SetupSurfacePhase, 'working'>, IconName>;

export type SetupMarkProps = Readonly<{
    phase: SetupSurfacePhase;
    stage: SetupStageId;
    /** Milestone fraction from `setupStageModel`; never interpolated here either. */
    completedFraction: number;
    /** Overrides the preference store, matching the motion primitives' contract. */
    reducedMotion?: boolean;
    accessibilityLabel: string;
    testID?: string;
}>;

function resolveGlyph(phase: SetupSurfacePhase, stage: SetupStageId): IconName {
    return phase === 'working' ? STAGE_GLYPHS[stage] : PHASE_GLYPHS[phase];
}

export function SetupMark(props: SetupMarkProps): React.ReactElement {
    const { theme } = useUnistyles();
    const preferredReducedMotion = useReducedMotionPreference();
    const reducedMotion = props.reducedMotion ?? preferredReducedMotion;
    const hostVisible = useIsHostVisible();
    const working = props.phase === 'working' || props.phase === 'checking';
    const activity = working ? resolveMotionPresentation('setupActivity', reducedMotion) : null;

    // The mark is monochrome, like the primary actions beside it: progress is drawn in the primary
    // text ink (black on light, near-white on dark), so the only colour on the surface is the one
    // that means something. Danger belongs to the glyph that reports the failure. The arc keeps
    // the progress ink: the stages that genuinely completed are still complete, and repainting
    // them would claim otherwise.
    const progressInk = theme.colors.text.primary;
    const glyphInk = props.phase === 'blocked'
        ? theme.colors.state.danger.foreground
        : progressInk;
    const arcInk = progressInk;
    const track = activity === 'substitute'
        ? theme.colors.state.active.border
        : theme.colors.border.strong;

    // The highlight belongs to the track that is still to come: it starts where the completed arc
    // ends, is a sixth of what is LEFT, and covers that remainder in the same share of the lap —
    // one object at one speed, never hidden under the full-strength arc it would otherwise cross.
    const remainingFraction = Math.min(1, Math.max(0, 1 - props.completedFraction));
    const sweepStartDeg = FULL_TURN_DEG * (1 - remainingFraction);
    const sweepLapMs = HIGHLIGHT_LAP_MS * remainingFraction;

    // Both gates matter: unmounting stops the SVG being composited at all, and cancelling stops
    // Reanimated holding a live repeating animation on the shared value behind it.
    const lapRunning = activity === 'animate' && hostVisible && remainingFraction > 0;
    const rotation = useSharedValue(sweepStartDeg);
    const highlightStyle = useAnimatedStyle(() => ({
        transform: [{ rotate: `${rotation.value}deg` }],
    }));

    React.useEffect(() => {
        // A hidden window paints nothing, so a lap that runs there is cost with no reader. The
        // highlight stays mounted and simply stops; returning to the window restarts the lap.
        if (!lapRunning) {
            cancelAnimation(rotation);
            rotation.value = sweepStartDeg;
            return;
        }
        rotation.value = sweepStartDeg;
        rotation.value = withRepeat(
            withTiming(FULL_TURN_DEG, { duration: sweepLapMs, easing: Easing.linear }),
            -1,
            false,
        );
        return () => {
            cancelAnimation(rotation);
        };
    }, [lapRunning, rotation, sweepLapMs, sweepStartDeg]);

    const radius = (RING_PX - RING_STROKE_PX) / 2;
    const circumference = 2 * Math.PI * radius;
    const glyph = resolveGlyph(props.phase, props.stage);
    const markKey = props.phase === 'working' ? `working:${props.stage}` : props.phase;

    return (
        <View
            testID={props.testID}
            accessibilityRole="image"
            accessibilityLabel={props.accessibilityLabel}
            style={styles.box}
        >
            <CapacityRing
                size={RING_PX}
                strokeWidth={RING_STROKE_PX}
                ratio={props.completedFraction}
                color={arcInk}
                trackColor={track}
                testID={props.testID ? `${props.testID}:ring` : undefined}
                progressTestID={props.testID ? `${props.testID}:arc` : undefined}
            >
                <StatusTransition
                    transitionKey={markKey}
                    size={GLYPH_PX}
                    fromScale={ICON_CIRCLE_INK_RATIO}
                    reducedMotion={reducedMotion}
                    testID={props.testID ? `${props.testID}:glyph` : undefined}
                >
                    <Icon name={glyph} size={GLYPH_PX} color={glyphInk} />
                </StatusTransition>
            </CapacityRing>
            {lapRunning ? (
                <Animated.View
                    pointerEvents="none"
                    aria-hidden={true}
                    accessibilityElementsHidden={true}
                    importantForAccessibility="no-hide-descendants"
                    style={[styles.highlight, highlightStyle]}
                    testID={props.testID ? `${props.testID}:highlight` : undefined}
                >
                    <Svg width={RING_PX} height={RING_PX} viewBox={`0 0 ${RING_PX} ${RING_PX}`}>
                        <Circle
                            cx={RING_PX / 2}
                            cy={RING_PX / 2}
                            r={radius}
                            fill="none"
                            stroke={arcInk}
                            strokeOpacity={HIGHLIGHT_OPACITY}
                            strokeWidth={RING_STROKE_PX}
                            strokeLinecap="round"
                            strokeDasharray={`${circumference * HIGHLIGHT_ARC_FRACTION * remainingFraction} ${circumference}`}
                            transform={`rotate(-90 ${RING_PX / 2} ${RING_PX / 2})`}
                        />
                    </Svg>
                </Animated.View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    box: {
        width: RING_PX,
        height: RING_PX,
        alignItems: 'center',
        justifyContent: 'center',
    },
    highlight: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: RING_PX,
        height: RING_PX,
    },
}));
