import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const routerState = vi.hoisted(() => ({
    push: vi.fn(),
}));

afterEach(() => {
    routerState.push.mockReset();
    standardCleanup();
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerState.push, back: vi.fn(), replace: vi.fn(), setParams: vi.fn() } }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
        translateLoose: (key: string) => key,
    });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => true),
}));

describe('HiddenInactiveSessionsEmptyState', () => {
    it('renders the list-style empty state and navigates to archived sessions', async () => {
        const { HiddenInactiveSessionsEmptyState } = await import('./HiddenInactiveSessionsEmptyState');
        const screen = await renderScreen(<HiddenInactiveSessionsEmptyState />);

        expect(screen.findByTestId('session-empty-state-card')).toBeNull();
        expect(screen.findByTestId('sessions-hidden-inactive-empty-state-list')).not.toBeNull();
        expect(screen.findByTestId('sessions-hidden-inactive-empty-state-title')).not.toBeNull();
        expect(screen.findByTestId('sessions-hidden-inactive-empty-state-description')).not.toBeNull();
        expect(screen.findByTestId('sessions-hidden-inactive-empty-state-open-archived')).not.toBeNull();

        await screen.pressByTestIdAsync('sessions-hidden-inactive-empty-state-open-archived');

        expect(routerState.push).toHaveBeenCalledWith('/session/archived');
    });
});
