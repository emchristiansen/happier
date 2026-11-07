import { useSyncExternalStore } from 'react';

import {
    getAnalyticsStatus,
    optIn,
    optOut,
    subscribeAnalyticsStatus,
} from '../analytics/analytics';
import { rich } from '../i18n/rich';
import { useSiteData } from '../i18n/siteData';

/**
 * The disclosure and the opt-out, in one footer line.
 *
 * This replaces a cookie banner and is deliberately not one. A banner would be
 * the first thing a visitor sees on a page selling end-to-end encryption and
 * self-hosting, and it would be asking permission for something we do not do —
 * we set no cookie, write no localStorage, and read nothing off the device (see
 * `cookieless_mode` in src/analytics/analytics.ts). What we owe the visitor is
 * not a modal but a truthful sentence and a working switch, permanently
 * available, below the fold, in the place people look for legal text.
 *
 * Opting out takes effect immediately for the rest of this page load (the
 * `before_send` kill switch) and for every future visit (one localStorage key,
 * which is the only thing this site ever writes to a device).
 */
export function AnalyticsNotice() {
    const { pageProse: { PAGE_PROSE } } = useSiteData();

    const status = useSyncExternalStore(
        subscribeAnalyticsStatus,
        getAnalyticsStatus,
        () => 'loading',
    );

    if (status === 'loading') return null;

    const optedOut = status === 'opted-out';

    function toggle() {
        if (optedOut) {
            optIn();
        } else {
            optOut();
        }
    }

    return (
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
                {optedOut
                    ? 'Anonymous analytics off.'
                    : status === 'active'
                      ? 'Anonymous, cookieless analytics.'
                      : status === 'browser-refused'
                        ? 'Analytics off — Global Privacy Control is enabled.'
                        : 'Anonymous analytics unavailable.'}
            </span>
            <a
                href="https://docs.happier.dev/legal/privacy#website-analytics"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 transition-opacity hover:opacity-100"
                style={{ opacity: 0.75 }}
            >{rich(PAGE_PROSE.analyticsNotice.p0)}</a>
            {status === 'active' || optedOut ? (
                <button
                    onClick={toggle}
                    className="underline underline-offset-2 transition-opacity hover:opacity-100"
                    style={{ opacity: 0.75 }}
                >
                    {optedOut ? 'Turn on' : 'Turn off'}
                </button>
            ) : null}
        </span>
    );
}
