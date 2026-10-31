import React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';
import type { Message } from '@/sync/domains/messages/messageTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const platformState = vi.hoisted(() => ({
    os: 'ios' as 'ios' | 'android' | 'web',
}));

installMessageViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformState.os;
                },
                select: (values: Record<string, unknown>) =>
                    values?.[platformState.os] ?? values?.default,
            },
        });
    },
    storage: async (importOriginal) => importOriginal(),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
});

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => true),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.filter(Boolean).map(flattenStyle));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

function findNearestAncestorStyle(node: { parent?: unknown }): Record<string, unknown> {
    let cursor = node.parent as ({ parent?: unknown; props?: { style?: unknown } } | null | undefined);
    while (cursor) {
        const style = flattenStyle(cursor.props?.style);
        if (Object.keys(style).length > 0) return style;
        cursor = cursor.parent as ({ parent?: unknown; props?: { style?: unknown } } | null | undefined);
    }
    return {};
}

describe('MessageView (copy button hitSlop)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it.each(['ios', 'android'] as const)(
        'renders inline message actions on %s instead of relying on long-press dropdowns',
        async (platformOS) => {
            platformState.os = platformOS;
            vi.resetModules();
            const { storage } = await import('@/sync/domains/state/storage');
            storage.setState((state) => ({ settings: { ...state.settings, transcriptMessageSelectionEnabled: true } }));
            const { MessageView } = await import('./MessageView');
            const { TranscriptMessageSelectionProvider } = await import('./messageSelection/TranscriptMessageSelectionContext');

            const message: any = {
                kind: 'user-text',
                localId: 'local-1',
                id: 'm1',
                text: 'hello',
            };

            const screen = await renderScreen(
                <TranscriptMessageSelectionProvider sessionId="s1" eligibleMessageIdsInOrder={['m1']}>
                    <MessageView message={message} metadata={null} sessionId="s1" />
                </TranscriptMessageSelectionProvider>,
            );

            const copyButtons = screen.findAll(
                (node: any) => node.type === 'Pressable' && node.props?.testID === 'transcript-message-copy:m1',
            );
            expect(copyButtons).toHaveLength(1);

            const selectButtons = screen.findAll(
                (node: any) => node.type === 'Pressable' && node.props?.testID === 'transcript-message-select:m1',
            );
            expect(selectButtons).toHaveLength(1);
            expect(selectButtons[0].props.hitSlop).toBe(15);

            await act(async () => {
                selectButtons[0].props.onPress?.({} as never);
            });
            const selectionCheckbox = screen.findByTestId('transcript-message-select-checkbox:m1');
            if (!selectionCheckbox) throw new Error('expected transcript selection checkbox to render');
            const selectionAnchorStyle = findNearestAncestorStyle(selectionCheckbox);
            expect(selectionAnchorStyle).toMatchObject({ position: 'absolute', right: 0 });
            expect(selectionAnchorStyle).not.toHaveProperty('left');
            expect(selectionAnchorStyle).not.toHaveProperty('marginBottom');

            const longPressables = screen.findAll(
                (node: any) => node.type === 'Pressable' && typeof node.props?.onLongPress === 'function',
            );
            expect(longPressables).toHaveLength(0);

            const dropdowns = screen.findAllByType('DropdownMenu');
            expect(dropdowns).toHaveLength(0);
        },
    );

    it.each([
        ['ios', true],
        ['android', true],
        ['web', true],
    ] as const)(
        'sets transcript markdown selectability on %s to %s',
        async (platformOS, expectedSelectable) => {
            platformState.os = platformOS;
            vi.resetModules();
            const { storage } = await import('@/sync/domains/state/storage');
            storage.setState((state) => ({ settings: { ...state.settings, transcriptMessageSelectionEnabled: true } }));
            const { MessageView } = await import('./MessageView');
            const { TranscriptMessageSelectionProvider } = await import('./messageSelection/TranscriptMessageSelectionContext');

            const message: any = {
                kind: 'user-text',
                localId: 'local-1',
                id: 'm1',
                text: 'hello',
            };

            const screen = await renderScreen(
                <TranscriptMessageSelectionProvider sessionId="s1" eligibleMessageIdsInOrder={['m1']}>
                    <MessageView message={message} metadata={null} sessionId="s1" />
                </TranscriptMessageSelectionProvider>,
            );

            const text = screen.findByType('EnrichedMarkdownText');
            expect(text.children.join('')).toBe('hello');
            expect(text.props.selectable).toBe(expectedSelectable);
        },
    );

    it('copies a markdown option through its rendered long-press action', async () => {
        platformState.os = 'ios';
        vi.resetModules();
        const Clipboard = await import('expo-clipboard');
        const { MessageView } = await import('./MessageView');
        const { TranscriptMessageSelectionProvider } = await import('./messageSelection/TranscriptMessageSelectionContext');

        const message: any = {
            kind: 'user-text',
            localId: 'local-1',
            id: 'm1',
            text: [
                '<options>',
                '<option>Run command</option>',
                '</options>',
            ].join('\n'),
        };

        const screen = await renderScreen(
            <TranscriptMessageSelectionProvider sessionId="s1" eligibleMessageIdsInOrder={['m1']}>
                <MessageView message={message} metadata={null} sessionId="s1" />
            </TranscriptMessageSelectionProvider>,
        );

        const [option] = screen.findAll((node) => typeof node.type === 'string'
            && String(node.type) === 'Pressable' && typeof node.props.onLongPress === 'function');
        expect(option).toBeDefined();
        await act(async () => { option.props.onLongPress(); });
        expect(Clipboard.setStringAsync).toHaveBeenCalledWith('Run command');
    });

    it.each(['user', 'structured-user', 'agent', 'web'] as const)(
        'keeps the %s hover wrapper from capturing native gestures while child copy remains usable',
        async (branch) => {
            platformState.os = branch === 'web' ? 'web' : 'android';
            vi.resetModules();
            const { MessageView } = await import('./MessageView');
            const Clipboard = await import('expo-clipboard');
            const message = {
                kind: branch === 'agent' ? 'agent-text' : 'user-text',
                id: 'gesture-message', localId: 'gesture-local', createdAt: 1,
                text: '```ts\nconst value = 1;\n```',
                ...(branch === 'structured-user' ? {
                    meta: { happier: { kind: 'review_comments.v1', payload: {
                        sessionId: 's1', comments: [{
                            id: 'comment', filePath: 'src/file.ts', source: 'file',
                            body: 'Review this line', createdAt: 1,
                            anchor: { kind: 'fileLine', startLine: 1 },
                            snapshot: { selectedLines: ['const value = 1;'], beforeContext: [], afterContext: [] },
                        }],
                    } } },
                } : {}),
            } satisfies Message;
            const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);
            const copyButton = screen.findByTestId('transcript-message-copy:gesture-message');
            if (!copyButton) throw new Error('Missing child copy action');
            const ancestors: ReactTestInstance[] = [];
            for (let node = copyButton.parent; node; node = node.parent) {
                if (typeof node.type === 'string') ancestors.push(node);
            }
            // A hover-only message host must neither acquire the RN JS responder nor
            // publish the available message and its actions as a disabled accessibility node.
            expect(ancestors.some((node) => String(node.type) === 'Pressable')).toBe(false);
            expect(ancestors.some((node) => node.props.disabled === true
                || node.props.accessibilityState?.disabled === true)).toBe(false);
            if (branch === 'web') {
                const wrapper = ancestors.find((node) => typeof node.props.onPointerEnter === 'function');
                if (!wrapper) throw new Error('Missing passive hover host');
                const actions = () => screen.findAllHostsByTestId('transcript-message-actions:gesture-message')[0];
                expect(flattenStyle(actions().props.style).pointerEvents).toBe('none');
                await act(async () => { wrapper.props.onPointerEnter(); });
                expect(flattenStyle(actions().props.style).pointerEvents).toBe('auto');
                await act(async () => { wrapper.props.onPointerLeave(); });
                expect(flattenStyle(actions().props.style).pointerEvents).toBe('none');
            }
            expect(copyButton.props.disabled).not.toBe(true);
            const writes = vi.mocked(Clipboard.setStringAsync);
            writes.mockClear();
            await act(async () => { await copyButton.props.onPress(); });
            expect(writes).toHaveBeenCalledWith(message.text);
        },
    );

    it('clears the copied glyph and reports a refused retry after a successful message copy', async () => {
        platformState.os = 'android';
        vi.resetModules();
        const { MessageView } = await import('./MessageView');
        const Clipboard = await import('expo-clipboard');
        const { Modal } = await import('@/modal');
        const writes = vi.mocked(Clipboard.setStringAsync);
        writes.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        const alert = vi.mocked(Modal.alert);
        alert.mockClear();
        const message = {
            kind: 'agent-text', id: 'copy-retry-message', localId: null, createdAt: 1, text: 'Copy this message',
        } satisfies Message;
        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);
        const button = screen.findByTestId('transcript-message-copy:copy-retry-message');
        if (!button) throw new Error('Missing message copy action');
        const glyph = () => button.findAll((node) => typeof node.type === 'string'
            && String(node.type) === 'Icon')[0]?.props.name;
        await act(async () => { await button.props.onPress(); });
        expect(glyph()).toBe('check');
        expect(alert).not.toHaveBeenCalled();
        await act(async () => { await button.props.onPress(); });
        expect(glyph()).toBe('copy');
        expect(alert).toHaveBeenCalledWith('common.error', 'items.failedToCopyToClipboard');
    });

});
