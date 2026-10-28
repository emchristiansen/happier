import { beforeEach, describe, expect, it, vi } from 'vitest';

const posthog = {
    capture: vi.fn(),
    init: vi.fn((_key: string, config: { loaded?: () => void }) => config.loaded?.()),
    set_config: vi.fn(),
};

vi.mock('posthog-js/dist/module.slim.no-external', () => ({ default: posthog }));

function installBrowser({ gpc = false, optedOut = false } = {}) {
    const storage = new Map<string, string>();
    if (optedOut) storage.set('happier:analytics', 'off');

    vi.stubGlobal('window', {
        location: { pathname: '/', search: '' },
        localStorage: {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
            removeItem: (key: string) => storage.delete(key),
        },
    });
    vi.stubGlobal('navigator', { globalPrivacyControl: gpc });
}

describe('analytics status', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
        installBrowser();
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
});
