import Constants from 'expo-constants';
import * as Updates from 'expo-updates';

import {
    getReleaseRingPublicLabel,
    normalizePublicReleaseRingId,
    type PublicReleaseRingLabel,
} from '@happier-dev/release-runtime/releaseRings';

import { config } from '@/config';

import { resolveAppVariant, type AppVariant } from './appVariant';

/**
 * `expo-updates` and `expo-constants` expose these fields only on some SDKs, platforms and
 * module stubs; a field that is absent (or whose module refuses the access) is simply unknown.
 */
function readOptionalField(source: unknown, key: string): unknown {
    try {
        return source && typeof source === 'object' ? (source as Record<string, unknown>)[key] : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The variant this build is running as, read from the same inputs every caller used to read
 * inline. Defaults to production when nothing identifies the build, which is the only safe
 * default for anything that installs a release.
 */
export function resolveCurrentAppVariant(): AppVariant {
    return (
        resolveAppVariant({
            appVariant: config.variant,
            updatesReleaseChannel: readOptionalField(Updates, 'releaseChannel'),
            updatesChannel: readOptionalField(Updates, 'channel'),
            manifestReleaseChannel: readOptionalField(readOptionalField(Constants, 'manifest'), 'releaseChannel'),
            expoConfigReleaseChannel: readOptionalField(readOptionalField(Constants, 'expoConfig'), 'releaseChannel'),
            envAppEnv: process.env.APP_ENV,
            envExpoPublicAppEnv: process.env.EXPO_PUBLIC_APP_ENV,
        }) ?? 'production'
    );
}

export function resolvePreferredPublicReleaseRingLabelForApp(params: Readonly<{
    identityVariant: string | null | undefined;
    variant: AppVariant;
}>): PublicReleaseRingLabel {
    const identityRing = normalizePublicReleaseRingId(params.identityVariant);
    if (identityRing) {
        return getReleaseRingPublicLabel(identityRing);
    }

    if (params.variant === 'preview') return 'preview';
    if (params.variant === 'development') return 'dev';
    return 'stable';
}

/**
 * The public release ring selected by this app identity. Release acquisition depends only on this
 * ring, never on the relay, so a relay change never invalidates it (plan C3).
 */
export function resolvePreferredPublicReleaseRingLabelForCurrentApp(): PublicReleaseRingLabel {
    return resolvePreferredPublicReleaseRingLabelForApp({
        identityVariant: config.identityVariant,
        variant: resolveCurrentAppVariant(),
    });
}
