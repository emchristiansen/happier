import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createMcpActionChip } from './createMcpActionChip';

describe('createMcpActionChip', () => {
    it('routes visible and collapsed approaches through one intent owner', () => {
        const onIntent = vi.fn();
        const toggleCollapsedPopover = vi.fn();
        const chip = createMcpActionChip({
            label: 'MCP',
            selectedCount: 1,
            stabilityKey: 'stable',
            popoverContent: () => null,
            onIntent,
        });

        const renderedChip = chip.render({
            chipStyle: () => null,
            iconColor: 'currentColor',
            showLabel: true,
            textStyle: null,
            countTextStyle: null,
            chipAnchorRef: React.createRef(),
            popoverAnchorRef: React.createRef(),
            toggleCollapsedPopover,
        }) as React.ReactElement<{
            onFocus?: () => void;
            onHoverIn?: () => void;
            onPress?: () => void;
            onPressIn?: () => void;
        }>;

        renderedChip.props.onHoverIn?.();
        renderedChip.props.onFocus?.();
        renderedChip.props.onPressIn?.();
        renderedChip.props.onPress?.();
        chip.onIntent?.();

        expect(onIntent).toHaveBeenCalledTimes(4);
        expect(toggleCollapsedPopover).toHaveBeenCalledWith('new-session-mcp');
    });
});
