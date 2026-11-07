/**
 * How long a "what is the latest version?" answer stays fresh, and how soon a failed lookup is
 * tried again. One policy for every update source the app asks about itself (the desktop app, the
 * helper installables), so none of them invents its own cadence.
 */
export const LATEST_VERSION_CHECK_FRESH_MS = 24 * 60 * 60 * 1000;
export const LATEST_VERSION_CHECK_RETRY_MS = 30 * 60 * 1000;

/** Whether the last answer, taken at `checkedAt` (ms), is old enough to ask again. */
export function isLatestVersionCheckDue(params: Readonly<{ checkedAt: number; ok: boolean; now: number }>): boolean {
    const threshold = params.ok ? LATEST_VERSION_CHECK_FRESH_MS : LATEST_VERSION_CHECK_RETRY_MS;
    return params.now - params.checkedAt > threshold;
}
