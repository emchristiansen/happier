/** Select the API endpoint stored on a profile, preserving its canonical relay identity. */
export function resolveServerProfileApiUrl(profile: Readonly<{ serverUrl: string; localServerUrl?: string | null }>): string {
  return String(profile.localServerUrl ?? '').trim().replace(/\/+$/, '')
    || String(profile.serverUrl).trim().replace(/\/+$/, '');
}
