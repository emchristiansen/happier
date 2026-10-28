import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const reducedMotionState = vi.hoisted(() => ({ enabled: false }));
vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reducedMotionState.enabled,
}));

// The window lifecycle is a genuine platform boundary; everything below it stays real.
const hostVisibleState = vi.hoisted(() => ({ visible: true }));
vi.mock('@/hooks/ui/useIsHostVisible', () => ({
    useIsHostVisible: () => hostVisibleState.visible,
}));

import { SetupMark } from './SetupMark';

beforeEach(() => {
    reducedMotionState.enabled = false;
    hostVisibleState.visible = true;
});

describe('SetupMark', () => {
    it('shows the travelling highlight only while work is in progress', async () => {
        const working = await renderScreen(
            <SetupMark phase="working" stage="connect" completedFraction={0.25} accessibilityLabel="step" testID="mark" />,
        );
        const checking = await renderScreen(
            <SetupMark phase="checking" stage="prepare" completedFraction={0} accessibilityLabel="step" testID="mark" />,
        );
        const blocked = await renderScreen(
            <SetupMark phase="blocked" stage="service" completedFraction={0.5} accessibilityLabel="step" testID="mark" />,
        );

        expect(working.findByTestId('mark:highlight')).not.toBeNull();
        expect(checking.findByTestId('mark:highlight')).not.toBeNull();
        expect(blocked.findByTestId('mark:highlight')).toBeNull();
    });

    it('stops the lap while the window is hidden and resumes it on return', async () => {
        const visible = await renderScreen(
            <SetupMark phase="working" stage="service" completedFraction={0.5} accessibilityLabel="step" testID="mark" />,
        );
        expect(visible.findByTestId('mark:highlight')).not.toBeNull();

        hostVisibleState.visible = false;
        const hidden = await renderScreen(
            <SetupMark phase="working" stage="service" completedFraction={0.5} accessibilityLabel="step" testID="mark" />,
        );
        expect(hidden.findByTestId('mark:highlight')).toBeNull();
        // Hiding removes the motion, never a fact: the ring, its fraction and the glyph stay.
        expect(hidden.findByTestId('mark:arc')?.props.strokeDashoffset)
            .toBe(visible.findByTestId('mark:arc')?.props.strokeDashoffset);
        expect(hidden.findByTestId('mark:glyph')).not.toBeNull();

        hostVisibleState.visible = true;
        const returned = await renderScreen(
            <SetupMark phase="working" stage="service" completedFraction={0.5} accessibilityLabel="step" testID="mark" />,
        );
        expect(returned.findByTestId('mark:highlight')).not.toBeNull();
    });

    it('substitutes the highlight under reduced motion and keeps the fraction and glyph', async () => {
        const full = await renderScreen(
            <SetupMark phase="working" stage="service" completedFraction={0.5} accessibilityLabel="step" testID="mark" />,
        );
        const reduced = await renderScreen(
            <SetupMark phase="working" stage="service" completedFraction={0.5} accessibilityLabel="step" testID="mark" reducedMotion />,
        );

        expect(full.findByTestId('mark:highlight')).not.toBeNull();
        expect(reduced.findByTestId('mark:highlight')).toBeNull();
        expect(reduced.findByTestId('mark:arc')?.props.strokeDashoffset).toBe(full.findByTestId('mark:arc')?.props.strokeDashoffset);
        // The substitute is a tinted track, not a bare one.
        expect(reduced.findByTestId('mark:ring')).not.toBeNull();
        const fullTrack = full.tree.root.findAll((node) => String(node.type) === 'Circle' && node.props.strokeDasharray === undefined)[0];
        const reducedTrack = reduced.tree.root.findAll((node) => String(node.type) === 'Circle' && node.props.strokeDasharray === undefined)[0];
        expect(reducedTrack?.props.stroke).not.toBe(fullTrack?.props.stroke);
    });

    it('hands the milestone fraction to the ring unchanged', async () => {
        const quarter = await renderScreen(
            <SetupMark phase="working" stage="connect" completedFraction={0.25} accessibilityLabel="step" testID="mark" />,
        );
        const half = await renderScreen(
            <SetupMark phase="working" stage="service" completedFraction={0.5} accessibilityLabel="step" testID="mark" />,
        );
        const quarterOffset = Number(quarter.findByTestId('mark:arc')?.props.strokeDashoffset);
        const halfOffset = Number(half.findByTestId('mark:arc')?.props.strokeDashoffset);
        const circumference = 2 * Math.PI * 31;
        expect(quarterOffset).toBeCloseTo(circumference * 0.75, 5);
        expect(halfOffset).toBeCloseTo(circumference * 0.5, 5);
    });

    it('keeps the completed arc in the progress ink when setup stops', async () => {
        const working = await renderScreen(
            <SetupMark phase="working" stage="service" completedFraction={0.5} accessibilityLabel="step" testID="mark" />,
        );
        const blocked = await renderScreen(
            <SetupMark phase="blocked" stage="service" completedFraction={0.5} accessibilityLabel="step" testID="mark" />,
        );

        // The stages that genuinely completed are still complete: repainting their arc as danger
        // claims the failure undid them. Danger belongs to the glyph that reports it.
        expect(blocked.findByTestId('mark:arc')?.props.stroke).toBe(working.findByTestId('mark:arc')?.props.stroke);
        const glyph = blocked.root.findAll((node) => node.props?.name === 'warning-circle')[0];
        expect(glyph?.props.color).not.toBe(blocked.findByTestId('mark:arc')?.props.stroke);
    });

    it('sweeps the highlight through the track that is still to come', async () => {
        function dashLengthOf(screen: Awaited<ReturnType<typeof renderScreen>>): number {
            const circle = screen.findByTestId('mark:highlight')
                ?.findAll((node) => String(node.type) === 'Circle')[0];
            return Number(String(circle?.props.strokeDasharray).split(' ')[0]);
        }

        const fresh = await renderScreen(
            <SetupMark phase="working" stage="prepare" completedFraction={0} accessibilityLabel="step" testID="mark" />,
        );
        const halfway = await renderScreen(
            <SetupMark phase="working" stage="service" completedFraction={0.5} accessibilityLabel="step" testID="mark" />,
        );

        // The highlight belongs to the remaining track, so it is a sixth of what is LEFT: at the
        // half-way milestone it is half as long, travelling half the ring in half the lap — the
        // same speed, and never hidden under the full-strength completed arc.
        expect(dashLengthOf(halfway)).toBeCloseTo(dashLengthOf(fresh) / 2, 5);
    });
});
