import { describe, expect, it, vi } from 'vitest';

vi.mock('@/config', () => ({
    config: { identityVariant: 'publicdev', variant: 'preview' },
}));

vi.mock('expo-constants', () => ({
    default: { expoConfig: null, manifest: null },
}));

vi.mock('expo-updates', () => ({
    channel: null,
    releaseChannel: null,
}));

import { buildLocalRelayRuntimeSystemTaskSpec } from './buildLocalRelayRuntimeSystemTaskSpec';

describe('buildLocalRelayRuntimeSystemTaskSpec', () => {
    it('uses the current app release ring instead of pinning local relay installs to stable', () => {
        const spec = buildLocalRelayRuntimeSystemTaskSpec('relay.runtime.installOrUpdate.v1');

        expect(spec.params).toMatchObject({
            channel: 'dev',
        });
    });
});
