import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => `${key}:${String(params?.title ?? '')}:${String(params?.provider ?? '')}`,
    });
});

const confirmSpy = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: confirmSpy } }).module;
});
vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: Record<string, unknown>) => React.createElement('ItemRowActions', props),
}));

describe('DirectBrowseCandidateActions', () => {
    beforeEach(() => {
        confirmSpy.mockClear();
        confirmSpy.mockResolvedValue(true);
    });

    it('offers one accessible destructive delete action and confirms the provider-owned candidate', async () => {
        const onDelete = vi.fn();
        const { DirectBrowseCandidateActions } = await import('./DirectBrowseCandidateActions');
        const screen = await renderScreen(
            <DirectBrowseCandidateActions
                candidateId="remote-1"
                candidateTitle="Provider session"
                providerLabel="Kimi"
                deleting={false}
                onDelete={onDelete}
            />,
        );

        const rowActions = screen.tree.root.findByType('ItemRowActions' as never);
        expect(rowActions.props.compactThreshold).toBe(Number.POSITIVE_INFINITY);
        expect(rowActions.props.actions).toHaveLength(1);
        expect(rowActions.props.actions[0]).toMatchObject({
            id: 'delete_provider_session',
            destructive: true,
            disabled: false,
        });
        const trigger = rowActions.props.renderOverflowTrigger({
            toggle: vi.fn(),
            testID: 'candidate-actions',
        });
        expect(trigger.props.accessibilityLabel).toContain('Provider session');

        await act(async () => {
            rowActions.props.actions[0].onPress();
            await Promise.resolve();
        });

        expect(confirmSpy).toHaveBeenCalledWith(
            expect.stringContaining('deleteCandidateConfirmTitle'),
            expect.stringMatching(/Provider session.*Kimi/),
            expect.objectContaining({ destructive: true }),
        );
        expect(onDelete).toHaveBeenCalledTimes(1);
    });

    it('does not delete when confirmation is declined', async () => {
        confirmSpy.mockResolvedValueOnce(false);
        const onDelete = vi.fn();
        const { DirectBrowseCandidateActions } = await import('./DirectBrowseCandidateActions');
        const screen = await renderScreen(
            <DirectBrowseCandidateActions
                candidateId="remote-1"
                candidateTitle="Provider session"
                providerLabel="Kimi"
                deleting={false}
                onDelete={onDelete}
            />,
        );
        const rowActions = screen.tree.root.findByType('ItemRowActions' as never);

        await act(async () => {
            rowActions.props.actions[0].onPress();
            await Promise.resolve();
        });

        expect(onDelete).not.toHaveBeenCalled();
    });
});
