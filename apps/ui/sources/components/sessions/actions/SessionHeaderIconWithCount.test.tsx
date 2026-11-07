import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installNavigationCommonModuleMocks } from '@/components/ui/navigation/navigationTestHelpers';

installNavigationCommonModuleMocks();

const { SessionHeaderIconWithCount } = await import('./SessionHeaderIconWithCount');

describe('SessionHeaderIconWithCount', () => {
    it('keeps the count capsule open to font-scaled text', async () => {
        const screen = await renderScreen(
            <SessionHeaderIconWithCount count={12}>
                <React.Fragment />
            </SessionHeaderIconWithCount>,
        );
        const text = screen.tree.root.findByType('Text');
        const badge = screen.tree.root.findAll((node) => (
            node !== text
            && Boolean(node.props.style)
            && !Array.isArray(node.props.style)
            && node.props.style.position === 'absolute'
            && node.props.style.minWidth === 16
        ))[0];
        if (!badge) throw new Error('Expected count badge container');

        expect(badge.props.style).not.toHaveProperty('height');
        expect(badge.props.style).toMatchObject({ minHeight: 16, borderRadius: 999 });
        expect(text.props.allowFontScaling).not.toBe(false);
    });
});
