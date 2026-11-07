import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installCodeBlockCommonModuleMocks } from './codeBlockTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setStringAsyncSpy = vi.fn<(text: string) => Promise<boolean>>(async (_text) => true);
const alertSpy = vi.fn();

installCodeBlockCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: (...args: any[]) => alertSpy(...args),
            },
        }).module;
    },
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

vi.mock('expo-clipboard', () => ({
    setStringAsync: (text: string) => setStringAsyncSpy(text),
}));

function mockPlatform(os: 'android' | 'ios' | 'web') {
    // doMock (not the hoisted helper mock) so each test's platform survives vi.resetModules().
    vi.doMock('react-native', async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: os,
                select: (options: any) => options?.[os] ?? options?.default ?? options?.native ?? options?.ios ?? options?.android,
            },
        });
    });
}

describe('CodeBlockViewFrame', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('uses the platform ScrollView on Android so horizontal code drags share native nested scrolling with the transcript list', async () => {
        mockPlatform('android');
        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');

        const screen = await renderScreen(<CodeBlockViewFrame code={'x'} language={null} wrap={false} showCopyButton={false}>
                    <React.Fragment>child</React.Fragment>
                </CodeBlockViewFrame>);

        expect(screen.findAllByType('GestureHandlerScrollView' as any)).toHaveLength(0);
        const scrollViews = screen.findAllByType('ScrollView' as any);
        expect(scrollViews).toHaveLength(1);
        expect(scrollViews[0]!.props.horizontal).toBe(true);
        expect(scrollViews[0]!.props.nestedScrollEnabled).toBe(true);
    });

    it('keeps the gesture-handler ScrollView on iOS', async () => {
        mockPlatform('ios');
        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');

        const screen = await renderScreen(<CodeBlockViewFrame code={'x'} language={null} wrap={false} showCopyButton={false}>
                    <React.Fragment>child</React.Fragment>
                </CodeBlockViewFrame>);

        const scrollViews = screen.findAllByType('GestureHandlerScrollView' as any);
        expect(scrollViews).toHaveLength(1);
        expect(scrollViews[0]!.props.horizontal).toBe(true);
        expect(scrollViews[0]!.props.disallowInterruption).toBe(true);
    });

    it('keeps native code selection on Android only when there is no copy button to replace it', async () => {
        for (const [showCopyButton, expectedSelectable] of [[true, false], [false, true]] as const) {
            vi.resetModules();
            mockPlatform('android');
            const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');
            const { Text } = await import('@/components/ui/text/Text');

            const screen = await renderScreen(
                <CodeBlockViewFrame code={'x'} language={null} wrap={false} showCopyButton={showCopyButton}>
                    <Text selectable>const x = 1;</Text>
                </CodeBlockViewFrame>,
            );

            const codeText = screen.findAllByType('Text' as any).find((node) => node.props.children === 'const x = 1;');
            expect(codeText?.props.selectable, `showCopyButton=${showCopyButton}`).toBe(expectedSelectable);
        }
    });

    it('forwards scrollTestID when wrap is false (stable E2E locator)', async () => {
        mockPlatform('web');
        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');

        const screen = await renderScreen(
            <CodeBlockViewFrame
                code={'x'}
                language={null}
                wrap={false}
                showCopyButton={false}
                scrollTestID="markdown-code-block-scroll"
            >
                <React.Fragment>child</React.Fragment>
            </CodeBlockViewFrame>,
        );

        const scrollView = screen.findByTestId('markdown-code-block-scroll')!;
        expect(scrollView.props.testID).toBe('markdown-code-block-scroll');
        expect(scrollView.props.horizontal).toBe(true);
        expect(scrollView.props.nestedScrollEnabled).toBe(true);
    });

    it('positions copy button absolutely when there is no header content', async () => {
        mockPlatform('web');
        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<CodeBlockViewFrame code={'x'} language={null} wrap={true} showCopyButton={true}>
                    <React.Fragment>child</React.Fragment>
                </CodeBlockViewFrame>)).tree;

        const pressable = tree.findByProps({ accessibilityLabel: 'common.copy' });
        const flattened = Array.isArray(pressable.props.style) ? pressable.props.style.flat() : [pressable.props.style];
        expect(flattened.some((s: any) => s?.position === 'absolute')).toBe(true);
    });

    it('keeps copy button in the header when language is provided', async () => {
        mockPlatform('web');
        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<CodeBlockViewFrame code={'x'} language={'typescript'} wrap={true} showCopyButton={true}>
                    <React.Fragment>child</React.Fragment>
                </CodeBlockViewFrame>)).tree;

        const pressable = tree.findByProps({ accessibilityLabel: 'common.copy' });
        const flattened = Array.isArray(pressable.props.style) ? pressable.props.style.flat() : [pressable.props.style];
        expect(flattened.some((s: any) => s?.position === 'absolute')).toBe(false);
    });

    it('copies without showing a modal and shows a temporary copied state', async () => {
        setStringAsyncSpy.mockClear();
        alertSpy.mockClear();
        mockPlatform('web');

        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<CodeBlockViewFrame code={'hello'} language={null} wrap={true} showCopyButton={true}>
                    <React.Fragment>child</React.Fragment>
                </CodeBlockViewFrame>)).tree;

        const iconBefore = tree.findByType('Icon') as any;
        expect(iconBefore.props.name).toBe('copy');

        const pressable = tree.findByProps({ accessibilityLabel: 'common.copy' });
        await pressTestInstanceAsync(pressable, 'common.copy');

        expect(setStringAsyncSpy).toHaveBeenCalledWith('hello');
        expect(alertSpy).toHaveBeenCalledTimes(0);

        const iconAfter = tree.findByType('Icon') as any;
        expect(iconAfter.props.name).toBe('check');
    });

    it('keeps the copy affordance ready to retry when the platform refuses a write', async () => {
        setStringAsyncSpy.mockResolvedValueOnce(false);
        mockPlatform('web');
        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');
        const screen = await renderScreen(
            <CodeBlockViewFrame code="hello" wrap showCopyButton>
                <React.Fragment>child</React.Fragment>
            </CodeBlockViewFrame>,
        );

        const button = screen.tree.findByProps({ accessibilityLabel: 'common.copy' });
        await pressTestInstanceAsync(button, 'common.copy');
        expect(screen.tree.findByType('Icon').props.name).toBe('copy');

        await pressTestInstanceAsync(button, 'common.copy');
        expect(screen.tree.findByType('Icon').props.name).toBe('check');

        setStringAsyncSpy.mockResolvedValueOnce(false);
        await pressTestInstanceAsync(button, 'common.copy');
        expect(screen.tree.findByType('Icon').props.name).toBe('copy');
    });
});
