import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, type FeaturesResponse } from '@happier-dev/protocol';

import { storage } from '@/sync/domains/state/storage';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import {
    isRuntimeFeatureEnabled,
    resolveRuntimeFeatureDecision,
    resolveRuntimeFeatureDecisionOrThrow,
} from './featureDecisionInputs';

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'server-1',
        serverUrl: 'https://api.example.test',
        kind: 'custom',
        generation: 1,
    }),
}));

const initialStorageState = storage.getState();

function createFeaturesResponse(friendsEnabled: boolean): FeaturesResponse {
    return FeaturesResponseSchema.parse({
        features: {
            social: {
                friends: { enabled: friendsEnabled },
            },
        },
        capabilities: {},
    });
}

describe('featureDecisionInputs', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        resetServerFeaturesClientForTests();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        resetServerFeaturesClientForTests();
    });

    it('returns a local-policy disabled decision when experiments are off', async () => {
        storage.getState().applySettingsLocal({
            experiments: false,
            featureToggles: { 'social.friends': true },
        });

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                status: 200,
                json: async () => createFeaturesResponse(true),
            })) as unknown as typeof fetch,
        );

        const decision = await resolveRuntimeFeatureDecision({
            featureId: 'social.friends',
        });

        expect(decision.state).toBe('disabled');
        expect(decision.blockedBy).toBe('local_policy');
        expect(decision.blockerCode).toBe('flag_disabled');
    });

    it('fails closed when /v1/features is missing', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: false,
                status: 404,
                json: async () => ({}),
            })) as unknown as typeof fetch,
        );

        const enabled = await isRuntimeFeatureEnabled({
            featureId: 'social.friends',
        });

        expect(enabled).toBe(false);
    });

    it('preserves a transient probe failure as a retryable error for state-loading callers', async () => {
        storage.getState().applySettingsLocal({
            experiments: true,
            featureToggles: { 'social.friends': true },
        });
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new TypeError('network unavailable');
        }) as unknown as typeof fetch);

        await expect(resolveRuntimeFeatureDecisionOrThrow({
            featureId: 'social.friends',
        })).rejects.toMatchObject({
            name: 'RuntimeFeatureDecisionUnavailableError',
            retryable: true,
        });
    });
});
