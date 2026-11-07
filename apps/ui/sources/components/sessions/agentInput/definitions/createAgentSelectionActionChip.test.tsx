import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createAgentSelectionActionChip } from './createAgentSelectionActionChip';

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: () => null,
}));

vi.mock('@/agents/registry/registryUi', () => ({
    getAgentPickerIconScale: () => 1,
}));

describe('createAgentSelectionActionChip', () => {
    it('routes pointer, focus, and touch approach through one intent owner', () => {
        const onIntent = vi.fn();
        const chip = createAgentSelectionActionChip({
            anchorRef: React.createRef(),
            agentId: 'codex',
            tint: 'currentColor',
            showLabel: true,
            label: 'Codex',
            chipStyle: () => null,
            textStyle: null,
            onPress: vi.fn(),
            onIntent,
        }) as React.ReactElement<{
            onHoverIn?: () => void;
            onPressIn?: () => void;
            onFocus?: () => void;
        }>;

        chip.props.onHoverIn?.();
        chip.props.onFocus?.();
        chip.props.onPressIn?.();

        expect(onIntent).toHaveBeenCalledTimes(3);
    });
});
