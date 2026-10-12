import * as React from 'react';
import { ScrollView, useWindowDimensions, View, type ViewStyle } from 'react-native';
import Animated, {
    useAnimatedStyle,
    useSharedValue,
    withDelay,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { resolveMotionSpring } from '@/components/ui/motion/motionSprings';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { resolveMotionPresentation } from '@/components/ui/motion/reducedMotionTable';
import { STATUS_TRANSITION_TIMELINE } from '@/components/ui/motion/StatusTransition';
import { Text } from '@/components/ui/text/Text';
import { SystemTaskProgressCard } from '@/components/systemTasks/SystemTaskProgressCard';
import type { SystemTaskRunState } from '@/components/systemTasks/types';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

import { SetupMark } from './SetupMark';
import { deriveSetupStageModel, type SetupLocalFacts, type SetupStageModel } from './setupStageModel';

/**
 * The one desktop setup surface (plan R7 / L5): one mark, one title, one changing status sentence,
 * one Details disclosure, and actions only when blocked — one primary recovery (Retry, or Update
 * for a command line too old for setup) and the calm way on without this computer. No card, no
 * border, no success page — completion settles the mark and the copy, and the surface leaves on
 * its own beat.
 *
 * R11 — it is a veil over the Home content only: the host places it over the Home route's own area,
 * so the sidebar, header chrome, navigation and every other route stay fully usable. It covers what
 * it is about and nothing else, and "Continue without this computer" takes it away for this run.
 * It never takes keyboard focus (the person may be typing in the sidebar); its sentence is
 * announced through a polite live region and every action stays keyboard-reachable.
 * `GlassSurface` turns solid under Reduce Transparency.
 *
 * The composition scrolls and is anchored from the TOP rather than optically centred. A centred
 * column re-centres on every height change, so opening Details or growing the blocked stack moved
 * the mark — the one thing that must hold still. Anchoring puts the mark at a fixed offset, lets
 * everything else grow downwards, and keeps both overflow edges reachable at a compact window
 * height or 200% text.
 *
 * The app shell remains the one owner of desktop window controls and titlebar dragging. Every fact
 * the surface shows comes from `deriveSetupStageModel` (the one stage derivation, INV6). Nothing
 * here reads a clock.
 */

export type SetupSurfaceProps = Readonly<{
    run: SystemTaskRunState | null;
    facts: SetupLocalFacts;
    /** Rendered only when blocked. */
    onRetry?: () => void;
    /**
     * U4 — the calm way on from a blocked state Retry cannot fix: without this computer for now.
     * Rendered only when blocked, always below the primary recovery.
     */
    onContinueWithout?: () => void;
    /**
     * R17 — the command line is older than setup needs and the app placed it: the recovery is the
     * one Update action (`cli.update.v1`), which replaces Retry for that state.
     */
    onUpdateCli?: () => void;
    /** The Update above is running; the button carries it rather than a second indicator. */
    updatingCli?: boolean;
    /**
     * Nothing is left to present: play the one departure beat. The surface stops taking input
     * immediately, so this is the surface leaving rather than a delay in front of the Home.
     */
    exiting?: boolean;
    /** Called once the departure beat is over, so the host can unmount the surface. */
    onExited?: () => void;
    /** Overrides the preference store, matching the motion primitives' contract. */
    reducedMotion?: boolean;
    testID?: string;
}>;

/** Mark, title, status: `0 / 60 / 120 ms`, each arriving on the `rowEnter` spring. */
const ENTRANCE_STAGGER_MS = 60;
const ENTRANCE_RISE_PX = 8;

/**
 * The departure, in two beats on the one timing curve: the content settles back down the 8 px it
 * rose and fades, then the veil clears. Both take the `fast` duration, so the whole exit is
 * shorter than the entrance it reverses — attention is already moving on to the Home.
 */
const EXIT_CONTENT_MS = reanimatedMotionTokens.durationMs.fast;
const EXIT_MATERIAL_MS = reanimatedMotionTokens.durationMs.fast;
export const SETUP_SURFACE_EXIT_MS = EXIT_CONTENT_MS + EXIT_MATERIAL_MS;

/** The status sentence reserves two lines, so a longer sentence moves nothing below it. */
const STATUS_LINE_HEIGHT_PX = 21;
const STATUS_RESERVED_LINES = 2;

/**
 * Where the mark sits. Just above the optical centre of the window, with a floor for short
 * windows — the same place a system installer puts it, and a fixed one, so nothing below the mark
 * can push it.
 */
const COLUMN_ANCHOR_FRACTION = 0.3;
const COLUMN_ANCHOR_MIN_PX = 40;

const styles = StyleSheet.create((theme) => ({
    /** Over the Home content the host gives it — never over the sidebar or other routes. */
    veil: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
    },
    fill: {
        flex: 1,
    },
    scroll: {
        flex: 1,
    },
    main: {
        flexGrow: 1,
        alignItems: 'center',
        paddingHorizontal: 24,
        paddingBottom: 40,
    },
    column: {
        width: '100%',
        maxWidth: 420,
        alignItems: 'center',
    },
    textBlock: {
        marginTop: 28,
        width: '100%',
        alignItems: 'center',
    },
    title: {
        fontSize: 24,
        lineHeight: 30,
        letterSpacing: -0.4,
        textAlign: 'center',
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    statusSwap: {
        marginTop: 8,
        width: '100%',
        minHeight: STATUS_LINE_HEIGHT_PX * STATUS_RESERVED_LINES,
    },
    status: {
        fontSize: 15,
        lineHeight: STATUS_LINE_HEIGHT_PX,
        textAlign: 'center',
        color: theme.colors.text.secondary,
    },
    /** A counter that changes many times a second holds its width: tabular numerals (U14). */
    downloadProgress: {
        fontVariant: ['tabular-nums'],
    },
    /** The quieter alternatives under the primary recovery, side by side where they fit. */
    secondaryActions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: 4,
    },
    actions: {
        marginTop: 40,
        alignItems: 'center',
        gap: 4,
    },
    details: {
        marginTop: 24,
        width: '100%',
        gap: 12,
    },
    /** The executor's own words, verbatim, for someone who came here to diagnose. */
    diagnostic: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.tertiary,
    },
}));

function useEntrance(order: number, animate: boolean, reducedMotion: boolean) {
    const opacity = useSharedValue(animate ? 0 : 1);
    const rise = useSharedValue(animate ? ENTRANCE_RISE_PX : 0);
    React.useEffect(() => {
        if (!animate) {
            opacity.value = 1;
            rise.value = 0;
            return;
        }
        const spring = resolveMotionSpring('rowEnter', { reducedMotion });
        opacity.value = withDelay(order * ENTRANCE_STAGGER_MS, withSpring(1, spring));
        rise.value = withDelay(order * ENTRANCE_STAGGER_MS, withSpring(0, spring));
    }, [animate, opacity, order, reducedMotion, rise]);
    return useAnimatedStyle(() => ({
        opacity: opacity.value,
        transform: [{ translateY: rise.value }],
    }));
}

/**
 * The departure beat. The column sinks back and fades, then the veil clears — the reverse of
 * the entrance, on the `rowExit` row of the reduced-motion table, which suppresses it entirely
 * when the user has asked for less motion. `onExited` fires once either way, so the host's only
 * job is to unmount.
 */
function useDeparture(params: Readonly<{ exiting: boolean; reducedMotion: boolean; onExited?: () => void }>) {
    const content = useSharedValue(1);
    const sink = useSharedValue(0);
    const material = useSharedValue(1);
    const exitTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    // Read only after the beat, never during render, so it stays out of the effect's dependencies.
    const onExitedRef = React.useRef(params.onExited);
    onExitedRef.current = params.onExited;
    const animate = resolveMotionPresentation('rowExit', params.reducedMotion) === 'animate';

    React.useEffect(() => {
        const easing = reanimatedMotionTokens.easing.standard;
        if (!params.exiting) {
            // A departure is interruptible: facts that need the surface again mid-beat bring it
            // back from wherever it got to, rather than leaving an invisible veil over the Home.
            if (!animate) {
                content.value = 1;
                sink.value = 0;
                material.value = 1;
                return;
            }
            content.value = withTiming(1, { duration: EXIT_CONTENT_MS, easing });
            sink.value = withTiming(0, { duration: EXIT_CONTENT_MS, easing });
            material.value = withTiming(1, { duration: EXIT_MATERIAL_MS, easing });
            return;
        }
        if (!animate) {
            onExitedRef.current?.();
            return;
        }
        content.value = withTiming(0, { duration: EXIT_CONTENT_MS, easing });
        sink.value = withTiming(ENTRANCE_RISE_PX, { duration: EXIT_CONTENT_MS, easing });
        material.value = withDelay(
            EXIT_CONTENT_MS,
            withTiming(0, { duration: EXIT_MATERIAL_MS, easing }),
        );
        exitTimerRef.current = setTimeout(() => {
            exitTimerRef.current = null;
            onExitedRef.current?.();
        }, SETUP_SURFACE_EXIT_MS);
        return () => {
            if (exitTimerRef.current != null) {
                clearTimeout(exitTimerRef.current);
                exitTimerRef.current = null;
            }
        };
    }, [animate, content, material, params.exiting, sink]);

    const contentStyle = useAnimatedStyle(() => ({
        opacity: content.value,
        transform: [{ translateY: sink.value }],
    }));
    const materialStyle = useAnimatedStyle(() => ({ opacity: material.value }));
    return { contentStyle, materialStyle };
}

/**
 * The status sentence swaps on the settle timeline (`110 / 40 / 130 ms`): the outgoing sentence
 * fades where it stands, the incoming one fades up after a beat. Under reduced motion the words
 * change at once — the fact still changes, only the travel goes.
 */
function useStatusSentenceSwap(sentence: string, reducedMotion: boolean) {
    const [displayed, setDisplayed] = React.useState(sentence);
    const opacity = useSharedValue(1);
    const swapTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const animate = resolveMotionPresentation('statusSettle', reducedMotion) === 'animate';

    React.useEffect(() => {
        if (sentence === displayed) return;
        if (swapTimerRef.current != null) {
            clearTimeout(swapTimerRef.current);
            swapTimerRef.current = null;
        }
        if (!animate) {
            opacity.value = 1;
            setDisplayed(sentence);
            return;
        }
        opacity.value = withTiming(0, {
            duration: STATUS_TRANSITION_TIMELINE.exitFadeMs,
            easing: reanimatedMotionTokens.easing.standard,
        });
        swapTimerRef.current = setTimeout(() => {
            swapTimerRef.current = null;
            setDisplayed(sentence);
            opacity.value = withDelay(
                STATUS_TRANSITION_TIMELINE.enterDelayMs,
                withTiming(1, {
                    duration: STATUS_TRANSITION_TIMELINE.enterFadeMs,
                    easing: reanimatedMotionTokens.easing.standard,
                }),
            );
        }, STATUS_TRANSITION_TIMELINE.exitFadeMs);
    }, [animate, displayed, opacity, sentence]);

    React.useEffect(
        () => () => {
            if (swapTimerRef.current != null) clearTimeout(swapTimerRef.current);
        },
        [],
    );

    const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
    return { displayed, style };
}

/**
 * The disclosure, mounted only while blocked and only with something true to show. It arrives on
 * the same `rowEnter` beat as everything else rather than appearing from nowhere.
 */
function SetupSurfaceDetails(props: Readonly<{
    diagnostic: string | null;
    run: SystemTaskRunState | null;
    reducedMotion: boolean;
    testID: string;
}>): React.ReactElement {
    const entrance = useEntrance(
        0,
        resolveMotionPresentation('rowEnter', props.reducedMotion) === 'animate',
        props.reducedMotion,
    );
    return (
        <Animated.View style={[styles.details, entrance]} testID={`${props.testID}:detailsCard`}>
            {props.diagnostic ? (
                <Text selectable style={styles.diagnostic} testID={`${props.testID}:diagnostic`}>
                    {props.diagnostic}
                </Text>
            ) : null}
            {props.run ? <SystemTaskProgressCard snapshot={props.run} /> : null}
        </Animated.View>
    );
}

function SetupSurfaceContent(props: SetupSurfaceProps & Readonly<{
    model: SetupStageModel;
    reducedMotion: boolean;
    departureStyle: ReturnType<typeof useAnimatedStyle<ViewStyle>>;
}>) {
    const { model, reducedMotion } = props;
    const [detailsOpen, setDetailsOpen] = React.useState(false);
    const entranceAnimates = resolveMotionPresentation('rowEnter', reducedMotion) === 'animate';
    const markEntrance = useEntrance(0, entranceAnimates, reducedMotion);
    const titleEntrance = useEntrance(1, entranceAnimates, reducedMotion);
    const statusEntrance = useEntrance(2, entranceAnimates, reducedMotion);
    const status = useStatusSentenceSwap(model.statusSentence, reducedMotion);
    const { height: windowHeight } = useWindowDimensions();
    const blocked = model.phase === 'blocked';
    const testID = props.testID ?? 'setup-surface';
    const diagnostic = model.blocked?.message ?? null;
    // A run that SUCCEEDED is not a diagnosis of a blocked state: the generic card would report it
    // as done under "Setup stopped". A proof failure names itself in the sentence instead.
    const canShowDetails = blocked && (diagnostic != null || props.run?.result?.ok === false);

    // The details disclosure only exists while blocked; close it if the run moves on.
    React.useEffect(() => {
        if (!blocked) setDetailsOpen(false);
    }, [blocked]);

    // One primary recovery: the Update when the command line is simply too old for setup and the
    // app may update it, otherwise Retry.
    const primaryRecovery = !blocked
        ? null
        : model.blocked?.code === 'cli_below_setup_floor' && props.onUpdateCli
            ? 'update'
            : (props.onRetry ? 'retry' : null);

    const stage = model.stages[model.currentIndex] ?? 'prepare';
    const anchorTop = Math.max(COLUMN_ANCHOR_MIN_PX, Math.round(windowHeight * COLUMN_ANCHOR_FRACTION));

    return (
        <ScrollView
            style={styles.scroll}
            contentContainerStyle={[styles.main, { paddingTop: anchorTop }]}
            keyboardShouldPersistTaps="handled"
            testID={`${testID}:${model.phase}`}
        >
            <Animated.View style={[styles.column, props.departureStyle]}>
                <Animated.View style={markEntrance}>
                    <SetupMark
                        phase={model.phase}
                        stage={stage}
                        completedFraction={model.completedFraction}
                        reducedMotion={reducedMotion}
                        accessibilityLabel={model.stepAnnouncement}
                        testID={`${testID}:mark`}
                    />
                </Animated.View>
                <View style={styles.textBlock}>
                    <Animated.View style={titleEntrance}>
                        <Text
                            accessibilityRole="header"
                            style={styles.title}
                            testID={`${testID}:title`}
                        >
                            {model.title}
                        </Text>
                    </Animated.View>
                    <Animated.View
                        style={statusEntrance}
                        accessibilityLiveRegion="polite"
                        testID={`${testID}:live`}
                    >
                        <Animated.View style={[styles.statusSwap, status.style]}>
                            <Text style={styles.status} testID={`${testID}:status`}>
                                {status.displayed}
                            </Text>
                        </Animated.View>
                    </Animated.View>
                </View>
                {model.downloadProgress ? (
                    <Text style={[styles.status, styles.downloadProgress]} testID={`${testID}:download-progress`}>
                        {model.downloadProgress}
                    </Text>
                ) : null}
                <View style={styles.actions} testID={`${testID}:actions`}>
                    {primaryRecovery === 'update' ? (
                        <RoundButton
                            size="normal"
                            display="default"
                            title={t('setupSurface.updateCliAction')}
                            onPress={props.onUpdateCli}
                            loading={props.updatingCli === true}
                            accessibilityLabel={t('setupSurface.updateCliAction')}
                            testID={`${testID}:update-cli`}
                        />
                    ) : primaryRecovery === 'retry' ? (
                        <RoundButton
                            size="normal"
                            display="default"
                            title={t('common.retry')}
                            onPress={props.onRetry}
                            accessibilityLabel={t('common.retry')}
                            testID={`${testID}:retry`}
                        />
                    ) : null}
                    {blocked && (props.onContinueWithout || canShowDetails) ? (
                        <View style={styles.secondaryActions}>
                            {props.onContinueWithout ? (
                                <RoundButton
                                    size="small"
                                    display="inverted"
                                    title={t('setupSurface.continueWithoutAction')}
                                    onPress={props.onContinueWithout}
                                    accessibilityLabel={t('setupSurface.continueWithoutAction')}
                                    testID={`${testID}:continue-without`}
                                />
                            ) : null}
                            {canShowDetails ? (
                                <RoundButton
                                    size="small"
                                    display="inverted"
                                    title={detailsOpen ? t('setupSurface.hideDetails') : t('common.details')}
                                    onPress={() => setDetailsOpen((open) => !open)}
                                    accessibilityLabel={detailsOpen ? t('setupSurface.hideDetails') : t('common.details')}
                                    testID={`${testID}:details`}
                                />
                            ) : null}
                        </View>
                    ) : null}
                </View>
                {canShowDetails && detailsOpen ? (
                    <SetupSurfaceDetails
                        diagnostic={diagnostic}
                        run={props.run}
                        reducedMotion={reducedMotion}
                        testID={testID}
                    />
                ) : null}
            </Animated.View>
        </ScrollView>
    );
}

export function SetupSurface(props: SetupSurfaceProps): React.ReactElement {
    const { theme } = useUnistyles();
    const preferredReducedMotion = useReducedMotionPreference();
    const reducedMotion = props.reducedMotion ?? preferredReducedMotion;
    const { run, facts } = props;
    const model = React.useMemo(() => deriveSetupStageModel(run, facts), [run, facts]);
    const testID = props.testID ?? 'setup-surface';
    const exiting = props.exiting === true;
    const departure = useDeparture({
        exiting,
        reducedMotion,
        ...(props.onExited ? { onExited: props.onExited } : {}),
    });

    // While the surface is leaving, the Home beneath is already live: the beat is the departure,
    // never a delay in front of it.
    return (
        <Animated.View
            pointerEvents={exiting ? 'none' : 'auto'}
            style={[styles.veil, departure.materialStyle]}
            testID={`${testID}:veil`}
        >
            <GlassSurface
                style={styles.fill}
                blurIntensity={90}
                solidColor={theme.colors.background.canvas}
                testID={`${testID}:veilGlass`}
            >
                <SetupSurfaceContent
                    {...props}
                    model={model}
                    reducedMotion={reducedMotion}
                    departureStyle={departure.contentStyle}
                />
            </GlassSurface>
        </Animated.View>
    );
}
