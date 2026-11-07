// @vitest-environment jsdom
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import type { DesktopWindowPointerLikeEvent } from './DesktopWindowDragRegion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nativeWindowState = { isMaximized: false };
// The native IPC boundary is fake; titlebar policy and the desktop bridge stay real.
const invoke = vi.fn(async (command: string) => {
    if (command === 'desktop_get_window_chrome_policy') return { strategy: 'custom-controls' };
    if (command === 'desktop_toggle_window_maximize') nativeWindowState.isMaximized = !nativeWindowState.isMaximized;
    return true;
});

function windowActions() {
    return invoke.mock.calls.map(([command]) => command).filter((command) =>
        command === 'desktop_start_window_dragging' || command === 'desktop_toggle_window_maximize',
    );
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const web = await vi.importActual<typeof import('react-native')>('react-native-web');
    return createReactNativeWebMock({
        View: web.View,
        Pressable: web.Pressable,
        Platform: {
            OS: 'web',
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

describe('useDesktopWindowDragMouseProps', () => {
    beforeEach(() => {
        invoke.mockClear();
        nativeWindowState.isMaximized = false;
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('uses mouse click detail after pointer down to drag once and maximize on the second click', async () => {
        const { useDesktopWindowDragMouseProps } = await import('./DesktopWindowDragRegion');
        const hook = await renderHook(() => useDesktopWindowDragMouseProps(), {
            flushOptions: { cycles: 1, turns: 1 },
        });
        const dragProps: ReturnType<typeof useDesktopWindowDragMouseProps> & {
            onPointerDown?: (event: DesktopWindowPointerLikeEvent) => void;
        } = hook.getCurrent();
        const preventDefault = vi.fn();
        const draggableTarget = { closest: vi.fn(() => null) };

        await React.act(async () => {
            for (const detail of [1, 2]) {
                dragProps.onPointerDown?.({ buttons: 1, detail: 0, preventDefault, target: draggableTarget });
                dragProps.onMouseDown?.({ buttons: 1, detail, preventDefault, target: draggableTarget });
            }
        });

        expect(windowActions()).toEqual(['desktop_start_window_dragging', 'desktop_toggle_window_maximize']);
        expect(nativeWindowState.isMaximized).toBe(true);
    });

    it('toggles maximize from double-click titlebar mouse down without starting a drag', async () => {
        const { useDesktopWindowDragMouseProps } = await import('./DesktopWindowDragRegion');
        const hook = await renderHook(() => useDesktopWindowDragMouseProps(), {
            flushOptions: { cycles: 1, turns: 1 },
        });
        const dragProps = hook.getCurrent();
        const preventDefault = vi.fn();
        const draggableTarget = { closest: vi.fn(() => null) };

        await React.act(async () => {
            dragProps.onMouseDown?.({ buttons: 1, detail: 2, preventDefault, target: draggableTarget });
        });

        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(windowActions()).toEqual(['desktop_toggle_window_maximize']);
    });

    it('does not start dragging from nested interactive controls', async () => {
        const { useDesktopWindowDragMouseProps } = await import('./DesktopWindowDragRegion');
        const hook = await renderHook(() => useDesktopWindowDragMouseProps(), {
            flushOptions: { cycles: 1, turns: 1 },
        });
        const dragProps = hook.getCurrent();
        const preventDefault = vi.fn();
        const interactiveTarget = { closest: vi.fn(() => ({ role: 'button' })) };

        await React.act(async () => {
            dragProps.onMouseDown?.({ buttons: 1, detail: 2, preventDefault, target: interactiveTarget });
        });

        expect(preventDefault).not.toHaveBeenCalled();
        expect(windowActions()).toEqual([]);
    });

    it('preserves presses on a real React Native Web control without a button role', async () => {
        const { Pressable } = await vi.importActual<typeof import('react-native')>('react-native-web');
        const host = document.createElement('div');
        // Header actions can use Pressable without an explicit button role.
        host.innerHTML = renderToStaticMarkup(
            <Pressable onPress={() => {}}><span data-testid="back-icon" /></Pressable>,
        );
        const icon = host.querySelector('[data-testid="back-icon"]');
        expect(icon).not.toBeNull();
        expect(icon?.closest('button,[role="button"]')).toBeNull();

        const { useDesktopWindowDragMouseProps } = await import('./DesktopWindowDragRegion');
        const hook = await renderHook(() => useDesktopWindowDragMouseProps(), {
            flushOptions: { cycles: 1, turns: 1 },
        });
        const preventDefault = vi.fn();
        const event = { buttons: 1, preventDefault, target: icon };
        await React.act(async () => {
            hook.getCurrent().onMouseDown?.(event);
        });

        expect(preventDefault).not.toHaveBeenCalled();
        expect(windowActions()).toEqual([]);
    });

    it('keeps header controls clickable through document capture while blank chrome still drags', async () => {
        const { createRoot } = await import('react-dom/client');
        const { Pressable } = await import('react-native');
        const { Header } = await import('../Header');
        const { DesktopMainContentDragSurface } = await import('./DesktopMainContentDragSurface');
        const navigateBack = vi.fn();
        const close = vi.fn();
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        try {
            await React.act(async () => {
                root.render(
                    <div tabIndex={-1}>
                        <DesktopMainContentDragSurface enabled leftOffsetPx={0}>
                            <Header
                                safeAreaEnabled={false}
                                title={<span data-testid="blank-title" />}
                                headerLeft={() => (
                                    <Pressable onPress={navigateBack}>
                                        <span data-testid="header-back-icon" />
                                    </Pressable>
                                )}
                                headerRight={() => (
                                    <Pressable onPress={close} accessibilityRole="button">
                                        <span data-testid="header-close-icon" />
                                    </Pressable>
                                )}
                            />
                        </DesktopMainContentDragSurface>
                    </div>,
                );
            });
            for (const testID of ['header-back-icon', 'header-close-icon']) {
                const icon = host.querySelector(`[data-testid="${testID}"]`);
                expect(icon).not.toBeNull();
                const down = new MouseEvent('mousedown', {
                    bubbles: true, cancelable: true, buttons: 1, clientX: 16, clientY: 20,
                });
                await React.act(async () => {
                    icon?.dispatchEvent(down);
                    icon?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                    icon?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                });
                expect(down.defaultPrevented).toBe(false);
            }
            expect(navigateBack).toHaveBeenCalledOnce();
            expect(close).toHaveBeenCalledOnce();
            expect(windowActions()).toEqual([]);

            const blankTitle = host.querySelector('[data-testid="blank-title"]');
            expect(blankTitle).not.toBeNull();
            await React.act(async () => {
                blankTitle?.dispatchEvent(new MouseEvent('mousedown', {
                    bubbles: true, cancelable: true, buttons: 1, clientX: 100, clientY: 20,
                }));
            });
            for (const isMaximized of [true, false]) {
                await React.act(async () => {
                    blankTitle?.dispatchEvent(new MouseEvent('mousedown', {
                        bubbles: true, cancelable: true, buttons: 1, detail: 2, clientX: 100, clientY: 20,
                    }));
                });
                expect(nativeWindowState.isMaximized).toBe(isMaximized);
            }
            expect(windowActions()).toEqual([
                'desktop_start_window_dragging', 'desktop_toggle_window_maximize', 'desktop_toggle_window_maximize',
            ]);
        } finally {
            await React.act(async () => root.unmount());
            host.remove();
        }
    });

    it('maximizes and restores from the window-controls spacer without treating it as a button', async () => {
        const { createRoot } = await import('react-dom/client');
        const { DesktopWindowControlsSlot } = await import('../shell/desktopChrome/DesktopWindowControlsSlot');
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        try {
            await React.act(async () => root.render(<DesktopWindowControlsSlot enableDragging />));
            const spacer = host.querySelector('[data-testid="desktop-window-drag-region"]');
            expect(spacer).not.toBeNull();
            for (const isMaximized of [true, false]) {
                await React.act(async () => {
                    spacer?.dispatchEvent(new MouseEvent('mousedown', {
                        bubbles: true, cancelable: true, buttons: 1, detail: 2,
                    }));
                });
                expect(nativeWindowState.isMaximized).toBe(isMaximized);
            }
            expect(windowActions()).toEqual(['desktop_toggle_window_maximize', 'desktop_toggle_window_maximize']);
        } finally {
            await React.act(async () => root.unmount());
            host.remove();
        }
    });
});
