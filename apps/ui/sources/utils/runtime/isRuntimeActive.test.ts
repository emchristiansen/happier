import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeState = vi.hoisted(() => ({
    appState: 'active',
    platformOs: 'web',
    isTauriDesktop: false,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return runtimeState.platformOs;
            },
        },
        AppState: {
            get currentState() {
                return runtimeState.appState;
            },
        },
    });
});

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => runtimeState.isTauriDesktop,
}));

describe('isRuntimeActive', () => {
    const globalWithDocument = globalThis as unknown as {
        document?: { visibilityState?: string };
    };
    const originalDocument = globalWithDocument.document;

    beforeEach(() => {
        vi.resetModules();
        runtimeState.appState = 'active';
        runtimeState.platformOs = 'web';
        runtimeState.isTauriDesktop = false;
        globalWithDocument.document = { visibilityState: 'visible' };
    });

    afterEach(() => {
        vi.useRealTimers();
        globalWithDocument.document = originalDocument;
    });

    it('treats browser web as inactive when hidden', async () => {
        globalWithDocument.document = { visibilityState: 'hidden' };

        const { isRuntimeActive } = await import('./isRuntimeActive');

        expect(isRuntimeActive()).toBe(false);
    });

    it('treats Tauri desktop as active when the webview is hidden', async () => {
        runtimeState.isTauriDesktop = true;
        runtimeState.appState = 'background';
        globalWithDocument.document = { visibilityState: 'hidden' };

        const { isRuntimeActive } = await import('./isRuntimeActive');

        expect(isRuntimeActive()).toBe(true);
    });

    it('skips interval ticks while hidden and runs immediately when visible after overdue', async () => {
        vi.useFakeTimers();
        const visibilityListeners = new Set<() => void>();
        const documentStub = {
            visibilityState: 'hidden',
            addEventListener: vi.fn((event: string, listener: () => void) => {
                if (event === 'visibilitychange') visibilityListeners.add(listener);
            }),
            removeEventListener: vi.fn((event: string, listener: () => void) => {
                if (event === 'visibilitychange') visibilityListeners.delete(listener);
            }),
        };
        globalWithDocument.document = documentStub as unknown as Document;

        const { startRuntimeActiveGatedInterval } = await import('./isRuntimeActive') as {
            startRuntimeActiveGatedInterval: (tick: () => void, intervalMs: number) => () => void;
        };

        const tick = vi.fn();
        const stop = startRuntimeActiveGatedInterval(tick, 1_000);

        await vi.advanceTimersByTimeAsync(3_000);
        expect(tick).not.toHaveBeenCalled();

        documentStub.visibilityState = 'visible';
        for (const listener of visibilityListeners) listener();
        expect(tick).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(999);
        expect(tick).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(tick).toHaveBeenCalledTimes(2);

        stop();
        expect(documentStub.removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
        await vi.advanceTimersByTimeAsync(1_000);
        expect(tick).toHaveBeenCalledTimes(2);
    });
});


describe('computer focus lifecycle', () => {
    afterEach(() => { vi.unstubAllGlobals(); });
    it('republishes browser window focus and blur through the canonical lifecycle owner', async () => {
        const doc = new EventTarget();
        const win = new EventTarget();
        vi.stubGlobal('document', doc);
        vi.stubGlobal('window', win);
        const { subscribeToRuntimeActiveChange } = await import('./isRuntimeActive');
        const listener = vi.fn();
        const stop = subscribeToRuntimeActiveChange(listener, { includeWindowFocus: true });
        win.dispatchEvent(new Event('focus'));
        win.dispatchEvent(new Event('blur'));
        expect(listener).toHaveBeenCalledTimes(2);
        stop();
        win.dispatchEvent(new Event('focus'));
        expect(listener).toHaveBeenCalledTimes(2);
    });
});


describe('focused computer facts', () => {
    afterEach(() => { vi.unstubAllGlobals(); });
    it('does not mute phone pushes for a hidden computer window that still has focus', async () => {
        runtimeState.platformOs = 'web';
        runtimeState.isTauriDesktop = false;
        vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' });
        vi.stubGlobal('document', { visibilityState: 'hidden', hasFocus: () => true });
        const { readComputerUiFocusState } = await import('./isRuntimeActive');
        expect(readComputerUiFocusState()).toEqual({ computer: true, focused: false });
        runtimeState.isTauriDesktop = true;
        expect(readComputerUiFocusState()).toEqual({ computer: true, focused: false });
        vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => true });
        expect(readComputerUiFocusState()).toEqual({ computer: true, focused: true });
        runtimeState.isTauriDesktop = false;
    });

    it('requires explicit physical focus and excludes mobile/native hosts', async () => {
        runtimeState.platformOs = 'web';
        runtimeState.isTauriDesktop = false;
        vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' });
        vi.stubGlobal('document', {});
        const { readComputerUiFocusState } = await import('./isRuntimeActive');
        expect(readComputerUiFocusState()).toEqual({ computer: true, focused: false });
        vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => true });
        expect(readComputerUiFocusState()).toEqual({ computer: true, focused: true });
        vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' });
        expect(readComputerUiFocusState()).toEqual({ computer: false, focused: false });
        runtimeState.platformOs = 'ios';
        expect(readComputerUiFocusState()).toEqual({ computer: false, focused: false });
        runtimeState.platformOs = 'web';
    });

    it('does not suppress pushes when document focus or visibility is unknown', async () => {
        runtimeState.platformOs = 'web';
        runtimeState.isTauriDesktop = false;
        vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' });
        const { readComputerUiFocusState } = await import('./isRuntimeActive');
        vi.stubGlobal('document', { hasFocus: () => true });
        expect(readComputerUiFocusState()).toEqual({ computer: true, focused: false });
        vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => { throw new Error('Focus unavailable'); } });
        expect(readComputerUiFocusState()).toEqual({ computer: true, focused: false });
        vi.stubGlobal('document', undefined);
        expect(readComputerUiFocusState()).toEqual({ computer: true, focused: false });
    });
});


describe('active refresh subscription boundaries', () => {
    afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

    it('does not catch up an overdue active refresh merely because a visible window loses focus', async () => {
        vi.useFakeTimers();
        const doc = new EventTarget();
        Object.defineProperty(doc, 'visibilityState', { value: 'visible' });
        const win = new EventTarget();
        vi.stubGlobal('document', doc);
        vi.stubGlobal('window', win);
        const { isRuntimeActive, startRuntimeActiveGatedInterval } = await import('./isRuntimeActive');
        const refresh = vi.fn();
        const stop = startRuntimeActiveGatedInterval(refresh, 1_000);
        try {
            vi.setSystemTime(Date.now() + 2_000);
            expect(isRuntimeActive()).toBe(true);
            win.dispatchEvent(new Event('blur'));
            win.dispatchEvent(new Event('focus'));
            expect(isRuntimeActive()).toBe(true);
            expect(refresh).not.toHaveBeenCalled();
            doc.dispatchEvent(new Event('visibilitychange'));
            expect(refresh).toHaveBeenCalledTimes(1);
        } finally { stop(); }
    });
});
