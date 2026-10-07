// @vitest-environment jsdom

import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import { ANDROID_APK_URL, ANDROID_PLAY_URL } from '../data/downloads';
import { LocaleProvider } from '../i18n';
import { PrimaryCta } from './PrimaryCta';

describe('<PrimaryCta>', () => {
    afterEach(() => {
        document.body.replaceChildren();
    });

    it('sends Android visitors to the public Play listing instead of defaulting to the APK', async () => {
        Object.defineProperty(window.navigator, 'userAgent', {
            configurable: true,
            value: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36',
        });

        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);

        await act(async () => {
            root.render(
                <LocaleProvider locale="en" path="/">
                    <PrimaryCta />
                </LocaleProvider>,
            );
        });

        const hrefs = [...container.querySelectorAll<HTMLAnchorElement>('a')].map((link) => link.href);
        expect(hrefs).toContain(ANDROID_PLAY_URL);
        expect(hrefs).not.toContain(ANDROID_APK_URL);

        act(() => root.unmount());
    });
});
