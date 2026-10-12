import * as React from 'react';
import { View, type ViewProps, type ViewStyle } from 'react-native';

import {
    buildDotSpinnerFilmstripSvg,
    buildDotSpinnerStillSvg,
    getDotSpinnerFrames,
    type DotSpinnerInk,
} from './dotSpinnerFrames';
import type { DotSpinnerStyleId, DotSpinnerTiming } from './dotSpinnerStyles';
import type { DotSpinnerMotion } from './dotSpinnerMotion';

const FILMSTRIP_ANIMATION_NAME = 'happierActivitySpinnerFilmstrip';
const BREATH_ANIMATION_NAME = 'happierActivitySpinnerBreath';
const FRAME_SHEET_ATTRIBUTE = 'data-happier-activity-spinner';

type WebAnimationStyle = ViewStyle & {
    animationDirection?: 'alternate';
    animationDuration?: string;
    animationIterationCount?: string;
    animationName?: string;
    animationTimingFunction?: string;
};

const BREATH_STYLE: WebAnimationStyle = {
    animationName: BREATH_ANIMATION_NAME,
    animationDuration: '1200ms',
    animationDirection: 'alternate',
    animationIterationCount: 'infinite',
    animationTimingFunction: 'ease-in-out',
};

const useInsertionEffectSafe: typeof React.useEffect =
    typeof React.useInsertionEffect === 'function' ? React.useInsertionEffect : React.useLayoutEffect;

/**
 * One `<style>` rule per style × ink × pose, shared by every copy on the page. The frame sheet is a
 * ≈20 KB SVG; putting it in each spinner's inline style would copy it into every DOM node. The
 * document owns the cache, so removing a sheet lets the next mount rebuild it.
 */
function injectFrameSheet(key: string, buildSvg: () => string): void {
    if (typeof document === 'undefined') return;
    const id = `happier-activity-spinner-${key}`;
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent =
        `[${FRAME_SHEET_ATTRIBUTE}="${key}"]{display:block;height:100%;` +
        `background:url("data:image/svg+xml,${encodeURIComponent(buildSvg())}") 0 0/100% 100% no-repeat}`;
    document.head.appendChild(style);
}

/**
 * Pins the strip's animation to the document timeline's origin, so every spinner on the page steps
 * on the same frames however far apart they mounted. Unsynced copies each make the compositor draw
 * on their own step boundaries: measured, the same 1000 strips cost ≈56% CPU synced and ≈82% not.
 */
function alignToDocumentClock(element: HTMLElement | null): void {
    if (!element || typeof element.getAnimations !== 'function') return;
    for (const animation of element.getAnimations()) {
        animation.startTime = 0;
    }
}

export function DotSpinnerWeb(props: Readonly<{
    styleId: DotSpinnerStyleId;
    timing: DotSpinnerTiming;
    size: number;
    ink: DotSpinnerInk;
    motion: DotSpinnerMotion;
    viewProps: ViewProps;
}>) {
    const { styleId, timing, size, ink, motion, viewProps } = props;
    const frames = getDotSpinnerFrames(styleId, timing);
    const animate = motion === 'animate';
    const inkKey = encodeURIComponent(JSON.stringify('color' in ink ? { color: ink.color } : { aurora: ink.aurora }));
    // The strip's frames depend on the timing; the still pose does not.
    const key = `${animate ? frames.key : styleId}-${animate ? 'strip' : 'still'}-${inkKey}`;
    const stripRef = React.useRef<HTMLSpanElement | null>(null);

    useInsertionEffectSafe(() => {
        injectFrameSheet(key, () => animate ? buildDotSpinnerFilmstripSvg(frames, ink) : buildDotSpinnerStillSvg(frames, ink));
    }, [animate, frames, ink, key]);

    React.useLayoutEffect(() => {
        if (animate) alignToDocumentClock(stripRef.current);
    }, [animate, key]);

    const boxStyle: WebAnimationStyle = { width: size, height: size, alignSelf: 'center', overflow: 'hidden' };

    return (
        <View {...viewProps} style={[boxStyle, motion === 'breathe' ? BREATH_STYLE : null, viewProps.style]}>
            {React.createElement('span', {
                [FRAME_SHEET_ATTRIBUTE]: key,
                ref: stripRef,
                style: animate
                    ? {
                        width: `${frames.frameCount * 100}%`,
                        animationName: FILMSTRIP_ANIMATION_NAME,
                        animationDuration: `${frames.cycleMs}ms`,
                        animationTimingFunction: `steps(${frames.frameCount}, end)`,
                        animationIterationCount: 'infinite',
                    }
                    : { width: '100%' },
            })}
        </View>
    );
}
