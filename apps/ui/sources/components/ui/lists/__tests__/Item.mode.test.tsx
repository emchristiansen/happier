import React from 'react';
import { act } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeWithProps, flattenTestStyle, renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '../uiListsTestHelpers';
import { lightTheme } from '@/theme';
import { ITEM_ICON_GLYPH_SIZE } from '@/components/ui/lists/itemDensityMetrics';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let uiItemDensitySetting: 'comfortable' | 'cozy' | 'compact' = 'comfortable';

function findTextNode(screen: Pick<ReactTestRenderer | ReactTestInstance, 'findAllByType'>, text: string) {
    return findTestInstanceByTypeWithProps(screen, 'Text' as any, { children: text });
}

function findHostNodeByTestID(
    screen: { findAllByTestId: (testID: string) => ReactTestInstance[] },
    testID: string,
) {
    return screen.findAllByTestId(testID).find((node) => typeof node.type === 'string');
}

function hasAncestor(node: ReactTestInstance, ancestor: ReactTestInstance): boolean {
    let current = node.parent;
    while (current) {
        if (current === ancestor) return true;
        current = current.parent;
    }
    return false;
}

installUiListsCommonModuleMocks();

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroupSelectionContext: React.createContext(null),
}));

vi.mock('@/components/ui/lists/ItemGroupRowPosition', () => ({
    useItemGroupRowPosition: () => 'middle',
}));

vi.mock('@/components/ui/lists/itemGroupRowCorners', () => ({
    getItemGroupRowCornerRadii: () => ({}),
}));

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: any) => node,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(),
}));

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: (key: string) => {
        if (key === 'uiItemDensity') return uiItemDensitySetting;
        if (key === 'uiFontScale') return 1;
        return null;
    },
}));

describe('Item mode prop', () => {
    beforeEach(() => {
        vi.resetModules();
        uiItemDensitySetting = 'comfortable';
    });

    it('renders a Pressable when mode is undefined and onPress is set', async () => {
        const { Item } = await import('../Item');
        const screen = await renderScreen(<Item title="Test" testID="item-default" onPress={() => {}} />);
        expect(findHostNodeByTestID(screen, 'item-default')?.type).toBe('Pressable');
    });

    it('renders a View (not Pressable) when mode="info" even with onPress', async () => {
        const { Item } = await import('../Item');
        const screen = await renderScreen(<Item title="Info Item" testID="item-info" mode="info" onPress={() => {}} />);
        expect(findHostNodeByTestID(screen, 'item-info')?.type).toBe('View');
    });

    it('never shows chevron when mode="info" regardless of showChevron prop', async () => {
        const { Item } = await import('../Item');
        const screen = await renderScreen(<Item title="Info" mode="info" showChevron={true} onPress={() => {}} />);
        expect(screen.findAllByProps({ name: 'caret-right' })).toHaveLength(0);
    });

    it('does NOT reduce opacity when mode="info" (unlike disabled)', async () => {
        const { Item } = await import('../Item');
        const screen = await renderScreen(<Item title="Info" testID="item-info-opacity" mode="info" />);
        const root = findHostNodeByTestID(screen, 'item-info-opacity');
        if (!root) {
            throw new Error('Expected info item host node to render');
        }
        const flattened = flattenTestStyle(root.props.style);
        expect(flattened.opacity).not.toBe(0.5);
    });

    it('reduces opacity when disabled (not mode="info")', async () => {
        const { Item } = await import('../Item');
        const screen = await renderScreen(<Item title="Disabled" testID="item-disabled-opacity" disabled={true} />);
        const root = findHostNodeByTestID(screen, 'item-disabled-opacity');
        if (!root) {
            throw new Error('Expected disabled item host node to render');
        }
        const flattened = flattenTestStyle(root.props.style);
        expect(flattened.opacity).toBe(0.5);
    });

    it('renders a Pressable when mode="interactive" with onPress', async () => {
        const { Item } = await import('../Item');
        const screen = await renderScreen(<Item title="Interactive" testID="item-interactive" mode="interactive" onPress={() => {}} />);
        expect(findHostNodeByTestID(screen, 'item-interactive')?.type).toBe('Pressable');
    });

    it('uses the middle global item density when density prop is omitted', async () => {
        uiItemDensitySetting = 'cozy';
        const { Item } = await import('../Item');
        const { ITEM_TITLE_TEXT_METRICS } = await import('../itemDensityMetrics');

        const screen = await renderScreen(<Item title="Cozy by setting" subtitle="Subtitle" />);

        const titleNode = findTextNode(screen, 'Cozy by setting');
        expect(flattenTestStyle(titleNode?.props?.style)).toMatchObject(ITEM_TITLE_TEXT_METRICS.cozy);
        uiItemDensitySetting = 'comfortable';
    });

    it('preserves an explicit density prop over the global item density', async () => {
        uiItemDensitySetting = 'compact';
        const { Item } = await import('../Item');
        const { ITEM_TITLE_TEXT_METRICS } = await import('../itemDensityMetrics');

        const screen = await renderScreen(<Item title="Explicit density" subtitle="Subtitle" density="comfortable" />);

        const titleNode = findTextNode(screen, 'Explicit density');
        expect(flattenTestStyle(titleNode?.props?.style)).toMatchObject(ITEM_TITLE_TEXT_METRICS.comfortable);
        uiItemDensitySetting = 'comfortable';
    });

    it('applies the resolved density to right-side detail text', async () => {
        uiItemDensitySetting = 'compact';
        const { Item } = await import('../Item');
        const { ITEM_TITLE_TEXT_METRICS } = await import('../itemDensityMetrics');

        const screen = await renderScreen(<Item title="Detail row" detail="Compact detail" />);

        const detailNode = findTextNode(screen, 'Compact detail');
        expect(flattenTestStyle(detailNode?.props?.style)).toMatchObject(ITEM_TITLE_TEXT_METRICS.compact);
        uiItemDensitySetting = 'comfortable';
    });

    it('forces icon prop size to the resolved density size', async () => {
        uiItemDensitySetting = 'cozy';
        const { Item } = await import('../Item');

        const screen = await renderScreen(
            <Item
                title="Density icon"
                icon={React.createElement('Ionicons', { name: 'stack', size: 29, color: '#09f' })}
            />,
        );

        const leftIcon = screen.findAllByProps({ name: 'stack' })[0];
        expect(leftIcon?.props?.size).toBe(ITEM_ICON_GLYPH_SIZE.cozy);
        uiItemDensitySetting = 'comfortable';
    });

    it('forces chevron size to the resolved density size', async () => {
        uiItemDensitySetting = 'compact';
        const { Item } = await import('../Item');

        const screen = await renderScreen(<Item title="Chevron row" onPress={() => {}} />);

        const chevronIcon = screen.findAllByProps({ name: 'caret-right' })[0];
        expect(chevronIcon?.props?.size).toBe(15);
        uiItemDensitySetting = 'comfortable';
    });

    it('suppresses the chevron when a rightElement is present (default)', async () => {
        const { Item } = await import('../Item');
        const screen = await renderScreen(
            <Item title="Badged" onPress={() => {}} rightElement={React.createElement('Text', null, 'badge')} />,
        );
        expect(screen.findAllByProps({ name: 'caret-right' })).toHaveLength(0);
    });

    it('keeps the chevron alongside a rightElement when keepChevronWithRightElement is set', async () => {
        const { Item } = await import('../Item');
        const screen = await renderScreen(
            <Item
                title="Badged + navigates"
                onPress={() => {}}
                rightElement={React.createElement('Text', null, 'badge')}
                keepChevronWithRightElement
            />,
        );
        expect(screen.findAllByProps({ name: 'caret-right' }).length).toBeGreaterThan(0);
    });

    it('keeps an interactive right accessory outside the activation owner without losing row accessibility actions', async () => {
        const rowPress = vi.fn();
        const accessoryPress = vi.fn();
        const onAccessibilityAction = vi.fn();
        const { Item } = await import('../Item');
        const { Pressable, Text } = await import('react-native');
        const screen = await renderScreen(
            <Item
                title="Review"
                testID="review-row"
                onPress={rowPress}
                rightElement={(
                    <Pressable testID="review-row-action" onPress={accessoryPress}>
                        <Text>Mark read</Text>
                    </Pressable>
                )}
                rightElementOutsidePressable
                accessibilityActions={[{ name: 'markRead', label: 'Mark read' }]}
                onAccessibilityAction={onAccessibilityAction}
            />,
        );

        const row = findHostNodeByTestID(screen, 'review-row');
        const accessory = findHostNodeByTestID(screen, 'review-row-action');
        if (!row || !accessory) throw new Error('Expected row and accessory activation owners');

        expect(row.type).toBe('Pressable');
        expect(accessory.type).toBe('Pressable');
        expect(hasAncestor(accessory, row)).toBe(false);
        expect(row.props.accessibilityActions).toEqual([{ name: 'markRead', label: 'Mark read' }]);

        await act(async () => {
            row.props.onPress();
            accessory.props.onPress();
            row.props.onAccessibilityAction({ nativeEvent: { actionName: 'markRead' } });
        });

        expect(rowPress).toHaveBeenCalledOnce();
        expect(accessoryPress).toHaveBeenCalledOnce();
        expect(onAccessibilityAction).toHaveBeenCalledOnce();
    });

    it('paints split-row hover and press feedback on the full surface containing both controls', async () => {
        const { Item } = await import('../Item');
        const { Pressable, Text } = await import('react-native');
        const screen = await renderScreen(
            <Item
                title="Review"
                testID="split-row"
                onPress={() => {}}
                rightElement={(
                    <Pressable testID="split-row-action" onPress={() => {}}>
                        <Text>Mark read</Text>
                    </Pressable>
                )}
                rightElementOutsidePressable
            />,
        );

        const row = () => findHostNodeByTestID(screen, 'split-row');
        const action = findHostNodeByTestID(screen, 'split-row-action');
        if (!row() || !action || !row()!.parent) throw new Error('Expected split row surface and controls');

        const initialSurface = row()!.parent!;
        expect(initialSurface.type).toBe('View');
        expect(hasAncestor(action, initialSurface)).toBe(true);
        expect(flattenTestStyle(initialSurface.props.style).backgroundColor).toBe('transparent');

        await act(async () => {
            row()!.props.onHoverIn();
        });
        expect(flattenTestStyle(row()!.parent!.props.style).backgroundColor).toBe(lightTheme.colors.surface.pressed);

        await act(async () => {
            row()!.props.onHoverOut();
            row()!.props.onPressIn();
        });
        expect(flattenTestStyle(row()!.parent!.props.style).backgroundColor).toBe(lightTheme.colors.surface.pressed);

        await act(async () => {
            row()!.props.onPressOut();
        });
        expect(flattenTestStyle(row()!.parent!.props.style).backgroundColor).toBe('transparent');
    });

    it('applies a hover background on web for interactive items', async () => {
        const { Item } = await import('../Item');
        const screen = await renderScreen(<Item title="Hover Row" testID="item-hover" onPress={() => {}} />);

        const beforeHover = findHostNodeByTestID(screen, 'item-hover');
        if (!beforeHover) {
            throw new Error('Expected hover item host node to render');
        }

        expect(typeof beforeHover.props.onHoverIn).toBe('function');
        expect(typeof beforeHover.props.onHoverOut).toBe('function');

        const beforeStyleFn = beforeHover.props.style as (state: { pressed: boolean }) => unknown;
        const beforeFlattened = flattenTestStyle(beforeStyleFn({ pressed: false }));
        expect(beforeFlattened.backgroundColor).toBe('transparent');

        await act(async () => {
            beforeHover.props.onHoverIn();
        });

        const afterHover = findHostNodeByTestID(screen, 'item-hover');
        if (!afterHover) {
            throw new Error('Expected hover item host node to render after hover');
        }

        const afterStyleFn = afterHover.props.style as (state: { pressed: boolean }) => unknown;
        const afterFlattened = flattenTestStyle(afterStyleFn({ pressed: false }));
        expect(afterFlattened.backgroundColor).toBe(lightTheme.colors.surface.pressed);
    });
});
