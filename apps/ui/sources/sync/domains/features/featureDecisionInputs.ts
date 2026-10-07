import { createFeatureDecision, type FeatureDecision, type FeatureId } from '@happier-dev/protocol';
import type { Settings } from '@/sync/domains/settings/settings';

import { storage } from '@/sync/domains/state/storage';
import {
    getServerFeaturesSnapshot,
} from '@/sync/api/capabilities/serverFeaturesClient';
import {
    resolveRuntimeFeatureDecisionFromSnapshot,
    type ServerFeaturesRuntimeSnapshot,
} from './featureDecisionRuntime';
import { resolveFeatureDecisionSnapshotStrategy } from './featureDecisionProbeStrategy';

export type RuntimeFeatureDecisionInputs = Readonly<{
    featureId: FeatureId;
    settings: Settings;
    snapshot: ServerFeaturesRuntimeSnapshot;
}>;

export type ResolveRuntimeFeatureDecisionParams = Readonly<{
    featureId: FeatureId;
    settings?: Settings;
    serverId?: string;
    timeoutMs?: number;
    force?: boolean;
}>;

export class RuntimeFeatureDecisionUnavailableError extends Error {
    readonly retryable = true;

    constructor(readonly decision: FeatureDecision) {
        super(`Runtime feature decision is temporarily unavailable for ${decision.featureId}`);
        this.name = 'RuntimeFeatureDecisionUnavailableError';
    }
}

export async function loadRuntimeFeatureDecisionInputs(
    params: ResolveRuntimeFeatureDecisionParams,
): Promise<RuntimeFeatureDecisionInputs> {
    const settings = params.settings ?? storage.getState().settings;
    const snapshotStrategy = resolveFeatureDecisionSnapshotStrategy({
        featureId: params.featureId,
        settings,
        scopeKind: 'runtime',
        hasMainSelectionServerIds: false,
    });

    const snapshot: ServerFeaturesRuntimeSnapshot = snapshotStrategy.runtimeEnabled
        ? await getServerFeaturesSnapshot({
            timeoutMs: params.timeoutMs,
            force: params.force,
            serverId: params.serverId,
        })
        : { status: 'loading' };

    return {
        featureId: params.featureId,
        settings,
        snapshot,
    };
}

export async function resolveRuntimeFeatureDecision(
    params: ResolveRuntimeFeatureDecisionParams,
): Promise<FeatureDecision> {
    const inputs = await loadRuntimeFeatureDecisionInputs(params);
    const decision = resolveRuntimeFeatureDecisionFromSnapshot(inputs);
    if (decision) {
        return decision;
    }

    return createFeatureDecision({
        featureId: inputs.featureId,
        state: 'unknown',
        blockedBy: 'server',
        blockerCode: 'probe_failed',
        diagnostics: [],
        evaluatedAt: Date.now(),
        scope: {
            scopeKind: 'runtime',
            ...(params.serverId ? { serverId: params.serverId } : {}),
        },
    });
}

export async function isRuntimeFeatureEnabled(
    params: ResolveRuntimeFeatureDecisionParams,
): Promise<boolean> {
    const decision = await resolveRuntimeFeatureDecision(params);
    return decision.state === 'enabled';
}

/**
 * State-loading paths must not collapse a transient server observation into a
 * durable "disabled" result. This boundary keeps the full feature decision
 * authoritative while making unknown decisions participate in the sync
 * owner's normal retry/backoff lifecycle.
 */
export async function resolveRuntimeFeatureDecisionOrThrow(
    params: ResolveRuntimeFeatureDecisionParams,
): Promise<FeatureDecision> {
    const decision = await resolveRuntimeFeatureDecision(params);
    if (decision.state === 'unknown') {
        throw new RuntimeFeatureDecisionUnavailableError(decision);
    }
    return decision;
}
