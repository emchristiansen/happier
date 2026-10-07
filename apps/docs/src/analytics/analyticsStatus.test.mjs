import assert from 'node:assert/strict';
import test from 'node:test';

function installBrowser({ gpc = false, optedOut = false } = {}) {
  const storage = new Map();
  if (optedOut) storage.set('happier:analytics', 'off');

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: (key) => storage.delete(key),
      },
    },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { globalPrivacyControl: gpc },
  });
}

test('reports an unavailable build key instead of blaming the browser', async () => {
  process.env.NEXT_PUBLIC_POSTHOG_KEY = '';
  installBrowser();
  const analytics = await import('./analytics.ts');
  const statuses = [];
  analytics.subscribeAnalyticsStatus(() => statuses.push(analytics.getAnalyticsStatus()));

  await analytics.start();

  assert.equal(analytics.getAnalyticsStatus(), 'unavailable');
  assert.deepEqual(statuses, ['unavailable']);
});

test('reports Global Privacy Control as the reason analytics did not start', async () => {
  process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
  installBrowser({ gpc: true });
  const analytics = await import('./analytics.ts');

  await analytics.start();

  assert.equal(analytics.getAnalyticsStatus(), 'browser-refused');
});
