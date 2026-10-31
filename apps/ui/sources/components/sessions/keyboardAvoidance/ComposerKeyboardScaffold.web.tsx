import * as React from 'react';
import { View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';

import { useOptionalModal } from '@/modal';
import { useIsInsideModalBoundary } from '@/modal/context/ModalBoundaryContext';
import { ComposerKeyboardProvider } from './ComposerKeyboardContext';
import type { ComposerKeyboardScaffoldProps } from './ComposerKeyboardScaffoldTypes';
import { useComposerKeyboardLayout } from './useComposerKeyboardLayout.web';

function normalizeScaffoldHeight(height: number): number | undefined {
    if (!Number.isFinite(height) || height <= 0) return undefined;
    return Math.round(height);
}

// The scaffold's own height is the composer's budget only when its host gives it a definite
// height. A content-sized host — the desktop /new route modal grows with its content up to a CSS
// cap and scrolls beyond it — makes that measurement circular: the budget becomes whatever the
// composer already occupies, so a large paste creeps the panel up a few pixels per layout pass.
// The bound is the nearest scrolling ancestor with a definite max-height (the route modal; its
// own content-sized scrolling body has none), and the room it can still grow into belongs to the
// budget too.
function readScrollingHostGrowthRoom(element: unknown): number {
    if (typeof HTMLElement === 'undefined' || !(element instanceof HTMLElement)) return 0;
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') continue;
        if (!style.maxHeight.endsWith('px')) continue;
        const maxHeight = Number.parseFloat(style.maxHeight);
        if (!Number.isFinite(maxHeight)) continue;
        // offsetHeight is the layout box, unaffected by the drawer's enter/exit transforms.
        return Math.max(0, maxHeight - ancestor.offsetHeight);
    }
    return 0;
}

export function ComposerKeyboardScaffold(props: ComposerKeyboardScaffoldProps): React.ReactElement {
    const { theme } = useUnistyles();
    const [availablePanelMaxHeight, setAvailablePanelMaxHeight] = React.useState<number | undefined>(undefined);
    const modal = useOptionalModal();
    const isInsideModalBoundary = useIsInsideModalBoundary();
    const keyboardLiftSuppressed = props.keyboardLiftSuppressed === true
        || (!isInsideModalBoundary && modal?.isKeyboardLiftSuppressedByModal === true);
    const layout = useComposerKeyboardLayout({
        availablePanelMaxHeight,
        headerHeight: props.headerHeight,
        keyboardLiftSuppressed,
        layoutBottomInset: props.layoutBottomInset,
        safeAreaBottom: props.safeAreaBottom,
    });
    const { height: windowHeight } = useWindowDimensions();
    const scaffoldLayoutRef = React.useRef<Readonly<{ height: number; element: unknown }> | null>(null);
    const publishAvailablePanelMaxHeight = React.useCallback(() => {
        const scaffoldLayout = scaffoldLayoutRef.current;
        if (!scaffoldLayout) return;
        const nextHeight = normalizeScaffoldHeight(
            scaffoldLayout.height + readScrollingHostGrowthRoom(scaffoldLayout.element),
        );
        setAvailablePanelMaxHeight((current) => (current === nextHeight ? current : nextHeight));
    }, []);
    const handleScaffoldLayout = React.useCallback((event: LayoutChangeEvent) => {
        // react-native-web exposes the measured DOM node as `nativeEvent.target`.
        const { target } = event.nativeEvent as LayoutChangeEvent['nativeEvent'] & { target?: unknown };
        scaffoldLayoutRef.current = { height: event.nativeEvent.layout.height, element: target };
        publishAvailablePanelMaxHeight();
    }, [publishAvailablePanelMaxHeight]);
    // A host cap derived from the viewport moves with the window without resizing the scaffold.
    React.useEffect(() => {
        publishAvailablePanelMaxHeight();
    }, [publishAvailablePanelMaxHeight, windowHeight]);
    const handleComposerLayout = React.useCallback((event: LayoutChangeEvent) => {
        layout.setComposerMeasuredHeight(event.nativeEvent.layout.height);
    }, [layout]);
    const liftPaddingStyle = useAnimatedStyle(() => ({
        paddingBottom: Math.max(0, layout.bottomInset.value - (props.safeAreaBottom ?? 0)),
    }));

    const { style: contentPropsStyle, ...contentProps } = props.contentProps ?? {};

    return (
        <ComposerKeyboardProvider layout={layout}>
            <Animated.View
                accessibilityLabel={props.accessibilityLabel}
                accessibilityRole={props.accessibilityRole}
                testID={props.testID}
                onLayout={handleScaffoldLayout}
                style={[
                    { flexBasis: 0, flexGrow: 1, minHeight: 0, backgroundColor: theme.colors.surface.base },
                    liftPaddingStyle,
                    props.style,
                ]}
            >
                <View
                    {...contentProps}
                    testID={props.contentTestID}
                    style={[{ flexBasis: 0, flexGrow: 1, minHeight: 0 }, contentPropsStyle, props.contentStyle]}
                >
                    {props.children}
                </View>
                <View
                    testID={props.composerTestID}
                    onLayout={handleComposerLayout}
                    style={{ backgroundColor: theme.colors.surface.base }}
                >
                    {props.composer}
                </View>
            </Animated.View>
        </ComposerKeyboardProvider>
    );
}
