import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    Platform: {
                        OS: 'web',
                    },
                    View: 'View',
                    Text: 'Text',
                    ActivityIndicator: 'ActivityIndicator',
                    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
                }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/components/ui/text/Text', () => ({ Text: (props: React.Attributes & Record<string, unknown>) => React.createElement('Text', props) }));

// The input modality is a real platform signal (pointer vs keyboard events on the document), so it
// is stubbed here; the ring logic below it stays real.
const modality = vi.hoisted(() => ({ keyboard: false }));
vi.mock('@/components/ui/interaction/inputModalityStore', () => ({
    useIsKeyboardModality: () => modality.keyboard,
}));

/** `FocusRing` is a composite; once painted it also renders a host with the same testID. */
function ringVisible(screen: { findAllByTestId: (id: string) => Array<{ props: Record<string, unknown> }> }, testID: string) {
    return screen.findAllByTestId(`${testID}-focus-ring`).find((node) => 'visible' in node.props)?.props.visible;
}

describe('RoundButton keyboard focus', () => {
    it('shows the canonical focus ring when a keyboard user focuses it, and never for a pointer', async () => {
        const { RoundButton } = await import('./RoundButton');

        modality.keyboard = true;
        const keyboard = await renderScreen(<RoundButton title="Retry" testID="ring-button" />);
        const pressable = keyboard.findByTestId('ring-button');
        // Mounted but not painted until focus actually lands.
        expect(ringVisible(keyboard, 'ring-button')).toBe(false);
        await act(async () => {
            pressable?.props.onFocus?.();
        });
        expect(ringVisible(keyboard, 'ring-button')).toBe(true);
        await act(async () => {
            keyboard.findByTestId('ring-button')?.props.onBlur?.();
        });
        expect(ringVisible(keyboard, 'ring-button')).toBe(false);

        // A tap focuses too. A ring that flashed on every tap would be worse than none.
        modality.keyboard = false;
        const pointer = await renderScreen(<RoundButton title="Retry" testID="pointer-button" />);
        await act(async () => {
            pointer.findByTestId('pointer-button')?.props.onFocus?.();
        });
        expect(ringVisible(pointer, 'pointer-button')).toBe(false);
    });

    it('suppresses the browser ring on web so exactly one indicator shows', async () => {
        const { RoundButton } = await import('./RoundButton');
        modality.keyboard = true;
        const screen = await renderScreen(<RoundButton title="Retry" testID="outline-button" />);
        const style = Object.assign(
            {},
            ...[screen.findByTestId('outline-button')?.props.style({ pressed: false })].flat(Infinity).filter(Boolean),
        );
        expect(style.outlineStyle).toBe('none');
    });

});

describe('RoundButton', () => {
    it('allows the complete action label to wrap while ordinary buttons remain single-line', async () => {
        const { RoundButton } = await import('./RoundButton');
        const label = 'Connect this computer here';
        const screen = await renderScreen(<>
            <RoundButton title="Short" testID="single-line" />
            <RoundButton title={label} titleNumberOfLines="complete" testID="complete-label" />
        </>);

        expect(screen.findByTestId('single-line')?.findByType('Text').props.numberOfLines).toBe(1);
        const completeLabel = screen.findByTestId('complete-label')?.findByType('Text');
        expect(completeLabel?.props.children).toBe(label);
        expect(completeLabel?.props.numberOfLines).toBeUndefined();
    });

    it('forwards the press event to modifier-aware actions', async () => {
        const { RoundButton } = await import('./RoundButton');
        const onPress = vi.fn();
        const event = { nativeEvent: { metaKey: true } };
        const screen = await renderScreen(<RoundButton title="New session" testID="round-button" onPress={onPress} />);

        screen.findByTestId('round-button')?.props.onPress(event);

        expect(onPress).toHaveBeenCalledWith(event);
    });

    it('forwards testID to the Pressable', async () => {
        const { RoundButton } = await import('./RoundButton');
        const screen = await renderScreen(<RoundButton title="Hello" testID="round-button" />);
        const pressable = screen.findByTestId('round-button');
        if (!pressable) {
            throw new Error('Expected round button pressable to render');
        }
        expect(pressable.props.testID).toBe('round-button');
        expect(pressable.findByType('LinearGradient' as never).props.colors).toEqual(['#000000', '#020202']);
    });

    it('applies a reduced effective opacity when disabled', async () => {
        const { RoundButton } = await import('./RoundButton');
        const screen = await renderScreen(<RoundButton title="Disabled" disabled={true} testID="disabled-round-button" />);
        const pressable = screen.findByTestId('disabled-round-button');
        if (!pressable) {
            throw new Error('Expected disabled round button pressable to render');
        }
        const styleOutput = pressable.props.style({ pressed: false });
        const flattened = Array.isArray(styleOutput)
            ? styleOutput.reduce((acc: Record<string, unknown>, next: Record<string, unknown> | null | undefined) => ({ ...acc, ...(next ?? {}) }), {})
            : (styleOutput ?? {});
        expect(flattened.opacity).toBe(0.35);
    });

    it('uses a scoped default size while preserving the global large default', async () => {
        const { RoundButton, RoundButtonSizeScope } = await import('./RoundButton');
        const screen = await renderScreen(<>
            <RoundButton title="Global" testID="global-button" />
            <RoundButtonSizeScope size="normal">
                <RoundButton title="Footer" testID="footer-button" />
                <RoundButton title="Explicit" size="small" testID="explicit-button" />
            </RoundButtonSizeScope>
        </>);

        const flatten = (style: unknown): Record<string, unknown> => Array.isArray(style)
            ? style.reduce((result, entry) => ({ ...result, ...flatten(entry) }), {})
            : ((style as Record<string, unknown> | null | undefined) ?? {});
        const fontSizeFor = (testID: string) => flatten(
            screen.findByTestId(testID)?.findByType('Text').props.style,
        ).fontSize;
        expect(fontSizeFor('global-button')).toBe(21);
        expect(fontSizeFor('footer-button')).toBe(16);
        expect(fontSizeFor('explicit-button')).toBe(14);
    });
});
