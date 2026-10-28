import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
};

const clipboardMocks = vi.hoisted(() => ({
    setStringAsync: vi.fn(async () => true),
}));
const modalMocks = vi.hoisted(() => ({
    alert: vi.fn(),
}));

vi.mock('expo-clipboard', () => clipboardMocks);

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'web',
            select: (options: Record<string, unknown>) => options?.web ?? options?.default,
        },
        Linking: {
            openURL: vi.fn(async () => undefined),
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: modalMocks,
    }).module;
});

vi.mock('@/components/qr', () => ({
    QRCode: (props: Record<string, unknown>) => React.createElement('QRCode', props),
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: Record<string, unknown>) => React.createElement('RoundButton', props),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) =>
        React.createElement('ItemGroup', { title }, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

describe('PublicLinkDialog copy feedback', () => {
    it('copies the public link without showing a success modal', async () => {
        clipboardMocks.setStringAsync.mockClear();
        modalMocks.alert.mockClear();
        const { PublicLinkDialog } = await import('./PublicLinkDialog');

        const screen = await renderScreen(
            <PublicLinkDialog
                publicShare={{
                    id: 'share-1',
                    sessionId: 'session-1',
                    token: 'public-token',
                    expiresAt: null,
                    maxUses: null,
                    useCount: 0,
                    isConsentRequired: true,
                    createdAt: 0,
                    updatedAt: 0,
                }}
                onCreate={vi.fn()}
                onDelete={vi.fn()}
                onClose={vi.fn()}
                setChrome={vi.fn()}
            />,
        );

        const copyItem = screen.findAllByType('Item' as any)
            .find((node: any) => node.props.title === 'common.copy');
        expect(copyItem).toBeTruthy();
        await act(async () => {
            await copyItem?.props.onPress();
        });

        expect(clipboardMocks.setStringAsync).toHaveBeenCalledWith('/share/public-token');
        expect(modalMocks.alert).not.toHaveBeenCalledWith('common.copied', 'items.copiedToClipboard');
        expect(screen.findByTestId('public-link-copy')?.props.rightElement?.props.testID)
            .toBe('public-link-copy-copied');
    });
});
