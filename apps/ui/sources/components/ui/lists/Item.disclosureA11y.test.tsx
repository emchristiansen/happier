import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Platform.OS is driven by a hoisted ref so a single react-native mock can
 * exercise BOTH the web aria bridge and the native pass-through without
 * re-mocking the module per test.
 */
const platformRef = vi.hoisted(() => ({ os: 'web' as 'web' | 'ios' }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const base = await createReactNativeWebMock();
    return {
        ...base,
        Platform: {
            ...base.Platform,
            get OS() {
                return platformRef.os;
            },
            select: (options: Record<string, unknown>) =>
                options[platformRef.os]
                    ?? options.default
                    ?? options.native
                    ?? options.ios
                    ?? options.android,
        },
    };
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: unknown) => node,
}));

vi.mock('@/components/ui/lists/useResolvedItemDensity', () => ({
    useResolvedItemDensity: () => 'comfortable',
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroupSelectionContext: React.createContext(null),
}));

vi.mock('@/components/ui/lists/ItemGroupRowPosition', () => ({
    useItemGroupRowPosition: () => null,
}));

vi.mock('@/components/ui/lists/itemGroupRowCorners', () => ({
    getItemGroupRowCornerRadii: () => null,
}));

describe('Item disclosure a11y pass-through', () => {
    it('bridges accessibilityState.expanded to a DOM aria-expanded attribute on web', async () => {
        platformRef.os = 'web';
        const { Item } = await import('./Item');
        const screen = await renderScreen(
            <Item
                testID="disclosure-row"
                title="Account"
                accessibilityState={{ expanded: true }}
                accessibilityLabel="Account, expanded"
                accessibilityHint="Double tap to collapse"
                onPress={() => {}}
            />,
        );

        const row = screen.findByTestId('disclosure-row');
        expect(row).toBeTruthy();
        // Assert the rendered DOM attribute, NOT the RN accessibilityState prop:
        // RN-Web does not derive aria-expanded from accessibilityState, so Item
        // must emit aria-expanded explicitly on web.
        expect(row?.props['aria-expanded']).toBe(true);
        expect(row?.props.accessibilityState).toEqual({ expanded: true });
        expect(row?.props.accessibilityLabel).toBe('Account, expanded');
        expect(row?.props.accessibilityHint).toBe('Double tap to collapse');
    });

    it('exposes a button role with an onPress so RN-Web PressResponder activates on Enter/Space', async () => {
        platformRef.os = 'web';
        const { Item } = await import('./Item');
        const onPress = vi.fn();
        const screen = await renderScreen(
            <Item
                testID="disclosure-row"
                title="Account"
                accessibilityState={{ expanded: false }}
                onPress={onPress}
            />,
        );

        const row = screen.findByTestId('disclosure-row');
        // RN-Web's PressResponder maps keyboard Enter/Space to onPress for
        // button-role pressables; assert the preconditions are wired.
        expect(row?.props.accessibilityRole).toBe('button');
        expect(typeof row?.props.onPress).toBe('function');
        expect(row?.props['aria-expanded']).toBe(false);

        row?.props.onPress();
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('forwards accessibilityState to the native Pressable without emitting aria-expanded', async () => {
        platformRef.os = 'ios';
        const { Item } = await import('./Item');
        const screen = await renderScreen(
            <Item
                testID="disclosure-row"
                title="Account"
                accessibilityState={{ expanded: true }}
                onPress={() => {}}
            />,
        );

        const row = screen.findByTestId('disclosure-row');
        expect(row?.props.accessibilityState).toEqual({ expanded: true });
        // Native must NOT carry the web-only aria attribute.
        expect(row?.props['aria-expanded']).toBeUndefined();
    });

    it('forwards native custom actions to the same Pressable that owns row activation', async () => {
        platformRef.os = 'ios';
        const { Item } = await import('./Item');
        const onPress = vi.fn();
        const onAccessibilityAction = vi.fn();
        const actions = [{ name: 'markRead', label: 'Mark as read' }] as const;
        const screen = await renderScreen(
            <Item
                testID="action-row"
                title="Unread session"
                onPress={onPress}
                accessibilityActions={actions}
                onAccessibilityAction={onAccessibilityAction}
            />,
        );

        const row = screen.findByTestId('action-row');
        expect(row?.props.onPress).toEqual(expect.any(Function));
        expect(row?.props.accessibilityActions).toBe(actions);
        expect(row?.props.onAccessibilityAction).toBe(onAccessibilityAction);
    });

    it('emits no aria-expanded attribute when accessibilityState is unset (back-compat)', async () => {
        platformRef.os = 'web';
        const { Item } = await import('./Item');
        const screen = await renderScreen(
            <Item testID="plain-row" title="Account" onPress={() => {}} />,
        );

        const row = screen.findByTestId('plain-row');
        expect(row?.props['aria-expanded']).toBeUndefined();
        expect(row?.props.accessibilityState).toBeUndefined();
    });
});
