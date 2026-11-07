import * as React from 'react';
import { Animated, Easing } from 'react-native';

/**
 * The native spinners' shared clocks.
 *
 * One `Animated.Value` per loop, driven on the UI thread by the native driver and held by every
 * mounted spinner that needs it: the first holder starts it, the last one to leave stops it. All
 * spinners of a cycle length therefore read one clock and step together, and no spinner runs any
 * per-frame JavaScript or worklet. A cycle clock goes 0 → 1 over one style cycle and each dot
 * interpolates its frame series against it; the breath clock eases 0 → 1 → 0 for reduced motion.
 */
type SharedLoop = {
    readonly value: Animated.Value;
    readonly build: (value: Animated.Value) => Animated.CompositeAnimation;
    animation: Animated.CompositeAnimation | null;
    holders: number;
};

const loops = new Map<string, SharedLoop>();

/** Half a breath, matching the web `happierActivitySpinnerBreath` alternate duration. */
const BREATH_HALF_CYCLE_MS = 1200;

function sharedLoop(key: string, build: SharedLoop['build']): SharedLoop {
    const existing = loops.get(key);
    if (existing) return existing;
    const loop: SharedLoop = { value: new Animated.Value(0), build, animation: null, holders: 0 };
    loops.set(key, loop);
    return loop;
}

function cycleLoop(cycleMs: number): SharedLoop {
    return sharedLoop(`cycle:${cycleMs}`, (value) => Animated.loop(
        Animated.timing(value, { toValue: 1, duration: cycleMs, easing: Easing.linear, useNativeDriver: true }),
    ));
}

function breathLoop(): SharedLoop {
    const easing = Easing.inOut(Easing.ease);
    return sharedLoop('breath', (value) => Animated.loop(Animated.sequence([
        Animated.timing(value, { toValue: 1, duration: BREATH_HALF_CYCLE_MS, easing, useNativeDriver: true }),
        Animated.timing(value, { toValue: 0, duration: BREATH_HALF_CYCLE_MS, easing, useNativeDriver: true }),
    ])));
}

function useHeldLoop(loop: SharedLoop, active: boolean): Animated.Value {
    React.useEffect(() => {
        if (!active) return undefined;
        loop.holders += 1;
        if (loop.holders === 1) {
            // Restart from the top: a native loop rewinds only to where its first iteration began.
            loop.value.setValue(0);
            loop.animation = loop.build(loop.value);
            loop.animation.start();
        }
        return () => {
            loop.holders -= 1;
            if (loop.holders === 0) {
                loop.animation?.stop();
                loop.animation = null;
            }
        };
    }, [active, loop]);
    return loop.value;
}

/** The shared 0 → 1 clock for one cycle length, running only while `active`. */
export function useDotSpinnerCycleClock(cycleMs: number, active: boolean): Animated.Value {
    return useHeldLoop(cycleLoop(cycleMs), active);
}

/** The shared reduced-motion breath clock, running only while `active`. */
export function useDotSpinnerBreathClock(active: boolean): Animated.Value {
    return useHeldLoop(breathLoop(), active);
}
