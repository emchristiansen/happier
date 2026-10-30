import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const posthog = {
    capture: vi.fn(),
    init: vi.fn((_key: string, config: { loaded?: () => void }) => config.loaded?.()),
    set_config: vi.fn(),
};

vi.mock('posthog-js/dist/module.slim.no-external', () => ({ default: posthog }));

function installBrowser({ gpc = false, optedOut = false, search = '', readFails = false, writeFails = false } = {}) {
    const storage = new Map<string, string>();
    if (optedOut) storage.set('happier:analytics', 'off');

    vi.stubGlobal('window', {
        location: { pathname: '/', search },
        localStorage: {
            getItem: vi.fn((key: string) => {
                if (readFails) throw new Error('storage read unavailable');
                return storage.get(key) ?? null;
            }),
            setItem: vi.fn((key: string, value: string) => {
                if (writeFails) throw new Error('storage write unavailable');
                storage.set(key, value);
            }),
            removeItem: vi.fn((key: string) => storage.delete(key)),
        },
    });
    vi.stubGlobal('navigator', { globalPrivacyControl: gpc });
}

describe('analytics status', () => {
    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
        installBrowser();
        const sdk = await import('posthog-js/dist/module.slim.no-external');
        expect(sdk.default).toBe(posthog);
        expect(sdk.default.init).toBe(posthog.init);
        expect(sdk.default.capture).toBe(posthog.capture);
        expect(sdk.default.set_config).toBe(posthog.set_config);
    });

    it('notifies the footer when lazy analytics becomes active and when the user opts out', async () => {
        const analytics = await import('./analytics');
        const statuses: string[] = [];
        const unsubscribe = analytics.subscribeAnalyticsStatus(() => {
            statuses.push(analytics.getAnalyticsStatus());
        });

        analytics.initAnalytics();
        await vi.waitFor(() => expect(analytics.getAnalyticsStatus()).toBe('active'));

        analytics.optOut();
        expect(analytics.getAnalyticsStatus()).toBe('opted-out');

        analytics.optIn();
        expect(analytics.getAnalyticsStatus()).toBe('active');
        expect(statuses).toEqual(['active', 'opted-out', 'active']);
        unsubscribe();
    });

    it('reports Global Privacy Control as the reason analytics did not start', async () => {
        installBrowser({ gpc: true });
        const analytics = await import('./analytics');

        analytics.initAnalytics();

        expect(analytics.getAnalyticsStatus()).toBe('browser-refused');
        expect(posthog.init).not.toHaveBeenCalled();
    });

    afterEach(async () => {
        await vi.dynamicImportSettled();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    for (const optedOut of [false, true]) {
        it(`applies URL opt-in once with stored refusal ${optedOut}`, async () => {
            installBrowser({ optedOut });
            // The URL recursion contract precedes the SDK loader. Keep that
            // loader disabled even on the old reentrant path: overlapping
            // dynamic imports can bypass Vitest's manual module mock.
            vi.stubEnv('VITE_POSTHOG_KEY', '');
            // Bound the old recursive path at the actual URL-read boundary.
            // Re-entry sees no override, so it can fail without exhausting the loader stack.
            const readQuery = vi.fn().mockReturnValueOnce('?analytics=on').mockReturnValue('');
            Object.defineProperty(window.location, 'search', { get: readQuery });
            const analytics = await import('./analytics');

            analytics.initAnalytics();
            await vi.dynamicImportSettled();

            expect(readQuery).toHaveBeenCalledTimes(1);
            expect(window.localStorage.removeItem).toHaveBeenCalledTimes(1);
            expect(posthog.init).not.toHaveBeenCalled();
            expect(analytics.readOptOut()).toBe(false);
            expect(analytics.getAnalyticsStatus()).toBe('unavailable');
        });
    }

    for (const options of [
        { readFails: false, writeFails: false },
        { readFails: false, writeFails: true },
        { readFails: true, writeFails: true },
    ]) {
        it(`honors URL opt-out with storage ${JSON.stringify(options)}`, async () => {
            installBrowser({ search: '?analytics=off', ...options });
            const analytics = await import('./analytics');

            analytics.initAnalytics();
            await vi.dynamicImportSettled();

            expect(analytics.getAnalyticsStatus()).toBe('opted-out');
            expect(analytics.readOptOut()).toBe(true);
            expect(posthog.init).not.toHaveBeenCalled();
        });
    }

    it('honors in-page opt-out while the lazy import is pending and persistence fails', async () => {
        installBrowser({ writeFails: true });
        const analytics = await import('./analytics');

        analytics.initAnalytics();
        analytics.optOut();
        await vi.dynamicImportSettled();

        expect(analytics.getAnalyticsStatus()).toBe('opted-out');
        expect(posthog.init).not.toHaveBeenCalled();
    });

    it('lets an explicit later opt-in supersede this page URL refusal when storage writes fail', async () => {
        installBrowser({ search: '?analytics=off', writeFails: true });
        const analytics = await import('./analytics');
        analytics.initAnalytics();
        await vi.dynamicImportSettled();
        expect(analytics.getAnalyticsStatus()).toBe('opted-out');

        analytics.optIn();
        await vi.dynamicImportSettled();

        expect(analytics.readOptOut()).toBe(false);
        expect(analytics.getAnalyticsStatus()).toBe('active');
        expect(posthog.init).toHaveBeenCalledTimes(1);
    });

    it('preserves browser refusal for URL opt-in', async () => {
        installBrowser({ search: '?analytics=on', gpc: true });
        const analytics = await import('./analytics');

        analytics.initAnalytics();
        await vi.dynamicImportSettled();

        expect(analytics.getAnalyticsStatus()).toBe('browser-refused');
        expect(posthog.init).not.toHaveBeenCalled();
    });

});
