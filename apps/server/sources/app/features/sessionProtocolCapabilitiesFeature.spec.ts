import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
    coerceBugReportsCapabilitiesFromFeaturesPayload,
    FeatureGatesSchema,
    FeaturesResponseSchema,
    SessionMessagesCapabilitiesSchema,
} from '@happier-dev/protocol';

import { resolveFeaturesFromEnv } from './registry';
import { resolveSessionProtocolCapabilitiesFeature } from './sessionProtocolCapabilitiesFeature';

// Retain the c7771d76711b6c360d82d336bd8b84f398888174 whole-response contract.
// Its feature gates, non-session capabilities, messages schema and bug-report
// coercion are unchanged; only the session subtree needs the retained definition.
const predecessorSessionProtocolSchema = z.object({
    protocolVersion: z.number().int().positive(),
}).strict();
const predecessorSessionDefaults = Object.freeze({
    messages: Object.freeze({ role: false, turns: false }),
});
const predecessorSessionCapabilitiesSchema = z.object({
    messages: SessionMessagesCapabilitiesSchema,
    runtimeActivity: predecessorSessionProtocolSchema.optional(),
    pendingInput: predecessorSessionProtocolSchema.optional(),
}).optional().default(predecessorSessionDefaults);
const predecessorCapabilitiesSchema = FeaturesResponseSchema.out.shape.capabilities.extend({
    session: predecessorSessionCapabilitiesSchema.optional().default(predecessorSessionDefaults),
});
const predecessorFeaturesResponseSchema = z.preprocess((raw: unknown): unknown => {
    const isRecord = (value: unknown): value is Record<string, unknown> =>
        value !== null && typeof value === 'object';
    if (!isRecord(raw)) return raw;
    const next = { ...raw } as Record<string, unknown>;
    if (!isRecord(next.capabilities)) {
        next.capabilities = {};
    }
    return {
        ...next,
        capabilities: {
            ...(next.capabilities as Record<string, unknown>),
            bugReports: coerceBugReportsCapabilitiesFromFeaturesPayload(next),
        },
    };
}, z.object({
    features: FeatureGatesSchema,
    capabilities: predecessorCapabilitiesSchema,
}));

describe('session protocol capability payload', () => {
    it('advertises Runtime Activity and Pending-input independently', () => {
        expect(resolveSessionProtocolCapabilitiesFeature()).toEqual({
            capabilities: {
                session: {
                    runtimeActivity: { protocolVersion: 2 },
                    pendingInput: { protocolVersion: 2 },
                    pendingInputExactLocalId: { protocolVersion: 1 },
                },
            },
        });
    });

    it('keeps the emitted features body readable by the strict c777 predecessor', () => {
        const body = resolveFeaturesFromEnv({});
        const predecessor = predecessorFeaturesResponseSchema.parse(body);

        expect(predecessor.capabilities.session.runtimeActivity).toEqual({ protocolVersion: 2 });
        expect(predecessor.capabilities.session.pendingInput).toEqual({ protocolVersion: 2 });
        expect(predecessor.capabilities.session).not.toHaveProperty('pendingInputExactLocalId');
        expect(FeaturesResponseSchema.parse(body).capabilities.session.pendingInputExactLocalId)
            .toEqual({ protocolVersion: 1 });

        expect(predecessorFeaturesResponseSchema.safeParse({
            ...body,
            capabilities: {
                ...body.capabilities,
                session: {
                    ...body.capabilities.session,
                    pendingInput: { protocolVersion: 2, exactLocalIdProtocolVersion: 1 },
                },
            },
        }).success).toBe(false);
    });
});
