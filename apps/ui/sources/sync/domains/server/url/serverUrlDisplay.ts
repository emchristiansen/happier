import { canonicalizeServerUrl } from './serverUrlCanonical';
import { redactPublicShareCapabilityUrl } from '@happier-dev/protocol';

export function toServerUrlDisplay(raw: string): string {
    const canonical = canonicalizeServerUrl(raw);
    if (!canonical) return '';
    try {
        const parsed = new URL(canonical);
        const port = parsed.port ? `:${parsed.port}` : '';
        const path = redactPublicShareCapabilityUrl(parsed.pathname).replace(/\/+$/, '');
        return `${parsed.protocol}//${parsed.hostname}${port}${path}`;
    } catch {
        return canonical;
    }
}

/**
 * The relay named the way a person says it: `api.happier.dev`, or `host:port` when the port is not
 * the scheme's default. One owner for the welcome footer's chip and the desktop setup sentence, so
 * two consecutive screens cannot name the same relay differently.
 *
 * Returns `null` when the URL cannot be parsed — the caller decides what to show instead.
 */
export function derivePresentableRelayHost(serverUrl: string): string | null {
    try {
        const parsed = new URL(serverUrl);
        const host = parsed.hostname;
        const port = parsed.port;
        const isDefaultPort = !port
            || (parsed.protocol === 'https:' && port === '443')
            || (parsed.protocol === 'http:' && port === '80');
        return isDefaultPort ? host : `${host}:${port}`;
    } catch {
        return null;
    }
}

/**
 * The same host presentation for a raw, possibly schemeless input: canonicalized first, so a
 * stored relay reads the same whichever way it was typed, and falling back to the full canonical
 * display when it cannot be parsed at all.
 */
export function toRelayHostDisplay(raw: string): string {
    const display = toServerUrlDisplay(raw);
    return derivePresentableRelayHost(display) ?? display;
}
