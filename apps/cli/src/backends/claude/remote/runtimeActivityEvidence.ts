import {
    createClaudeProviderActivityLedger,
    readClaudeProviderTaskActivity,
    readClaudeSessionHookProviderTaskActivity,
    type ClaudeProviderTaskActivity,
} from '@/backends/claude/providerActivity/createClaudeProviderActivityLedger';
import type { createClaudeProviderRuntimeActivityAdapter } from '@/backends/claude/providerActivity/createClaudeProviderRuntimeActivityAdapter';
import { logger } from '@/ui/logger';

type LoggerLike = Readonly<{
    debug: (message: string, ...args: unknown[]) => void;
}>;

export type ClaudeRuntimeActivityEvidence = {
    providerActivityLedger: ReturnType<typeof createClaudeProviderActivityLedger>;
};

type RuntimeActivityEffectParams = Readonly<{
    evidence: ClaudeRuntimeActivityEvidence;
    logger: LoggerLike;
    logPrefix: string;
    runtimeActivityAdapter?: ReturnType<typeof createClaudeProviderRuntimeActivityAdapter> | null;
}>;

export function createClaudeRuntimeActivityEvidence(options: Readonly<{
    providerActivityLedger?: ReturnType<typeof createClaudeProviderActivityLedger>;
}> = {}): ClaudeRuntimeActivityEvidence {
    return {
        providerActivityLedger: options.providerActivityLedger ?? createClaudeProviderActivityLedger(),
    };
}

export function isReplaySdkMessage(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return record.isReplay === true || record.is_replay === true;
}

const CLAUDE_REQUIRED_RUNTIME_ACTIVITY_HOOK_EVENTS = new Set([
    'PostToolUse',
    'SubagentStart',
    'SubagentStop',
]);

export function isClaudeLegacyRequiredHookObservationFailure(
    value: unknown,
    expectedSessionId: string | null | undefined,
): boolean {
    const sessionId = typeof expectedSessionId === 'string' ? expectedSessionId.trim() : '';
    if (!sessionId || !value || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    if (row.isReplay === true || row.is_replay === true) return false;
    if (row.type !== 'system' || row.subtype !== 'hook_response' || row.session_id !== sessionId) return false;
    if (typeof row.hook_event !== 'string' || !CLAUDE_REQUIRED_RUNTIME_ACTIVITY_HOOK_EVENTS.has(row.hook_event)) {
        return false;
    }
    return row.outcome === 'error' || row.outcome === 'cancelled';
}

function runRuntimeActivityEffect(
    params: RuntimeActivityEffectParams & Readonly<{
        label: string;
        effect: () => Promise<void> | void;
    }>,
): void {
    try {
        void Promise.resolve(params.effect()).catch((error) => {
            params.logger.debug(`${params.logPrefix} runtime activity ${params.label} failed (non-fatal)`, error);
        });
    } catch (error) {
        params.logger.debug(`${params.logPrefix} runtime activity ${params.label} failed (non-fatal)`, error);
    }
}

export function publishClaudeProviderTaskRuntimeActivity(
    params: RuntimeActivityEffectParams & Readonly<{ activity: ClaudeProviderTaskActivity }>,
): void {
    if (!params.runtimeActivityAdapter) {
        params.evidence.providerActivityLedger.apply(params.activity);
        return;
    }
    runRuntimeActivityEffect({
        ...params,
        label: params.activity.type,
        effect: () => params.runtimeActivityAdapter?.observeActivity({
            activity: params.activity,
            evidence: 'live',
        }),
    });
}

export function observeClaudeProviderTaskRuntimeActivityRow(
    params: RuntimeActivityEffectParams & Readonly<{ row: unknown }>,
): boolean {
    if (isReplaySdkMessage(params.row)) return false;
    const activity = readClaudeProviderTaskActivity(params.row);
    if (!activity) return false;
    publishClaudeProviderTaskRuntimeActivity({ ...params, activity });
    return true;
}

export function observeClaudeProviderTaskRuntimeActivityHook(
    params: RuntimeActivityEffectParams & Readonly<{ hook: unknown }>,
): boolean {
    const activity = readClaudeSessionHookProviderTaskActivity(params.hook);
    if (!activity) return false;
    publishClaudeProviderTaskRuntimeActivity({ ...params, activity });
    return true;
}

export function handleClaudeRuntimeActivityLoss(params: RuntimeActivityEffectParams & Readonly<{
    reason: string;
    providerStopped?: boolean;
}>): void {
    if (!params.runtimeActivityAdapter) {
        params.evidence.providerActivityLedger.noteObservationLost();
        if (params.providerStopped === true) {
            const abandoned = params.evidence.providerActivityLedger.abandonActiveProviderTasks();
            if (abandoned.length > 0) {
                logger.infoFile(`${params.logPrefix} abandoned provider tasks after process exit`, { reason: params.reason, abandoned });
            }
        }
        return;
    }
    runRuntimeActivityEffect({
        ...params,
        label: 'runtime-loss',
        effect: () => params.providerStopped === true
            ? params.runtimeActivityAdapter?.handleRuntimeLoss(params.reason, { providerStopped: true })
            : params.runtimeActivityAdapter?.handleRuntimeLoss(params.reason),
    });
}

export async function reconcileClaudeRuntimeActivity(params: RuntimeActivityEffectParams & Readonly<{
    reason: string;
}>): Promise<void> {
    if (!params.runtimeActivityAdapter) return;
    await params.runtimeActivityAdapter.publishCurrent(params.reason);
}
