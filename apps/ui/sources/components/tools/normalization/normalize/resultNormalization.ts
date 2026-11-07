import { isGenericSubAgentToolName } from '@happier-dev/protocol/tools/v2';

import { asRecord } from './_shared';
import {
    normalizeCodeSearchResultForRendering,
    normalizeGlobResultForRendering,
    normalizeGrepResultForRendering,
    normalizeLsResultForRendering,
    normalizeReasoningResultForRendering,
} from './search';
import { normalizeTodoResultForRendering } from './todos';

function normalizeAppliedResultAliases(result: unknown): Record<string, unknown> | null {
    const record = asRecord(result);
    if (!record) return null;
    if (typeof (record as any).applied === 'boolean') return null;
    const applied =
        typeof (record as any).ok === 'boolean'
            ? (record as any).ok
            : typeof (record as any).success === 'boolean'
                ? (record as any).success
                : null;
    if (typeof applied !== 'boolean') return null;
    return { ...record, applied };
}

export function normalizeToolResultForRendering(params: { canonicalToolName: string; result: unknown }): unknown {
    const canonicalLower = params.canonicalToolName.toLowerCase();
    let nextResult: unknown = params.result;

    if (isGenericSubAgentToolName(params.canonicalToolName)) {
        const record = asRecord(nextResult);
        // Native Claude task notifications carry findings as result; renderers
        // consume the canonical Task content field while status stays intact.
        if (record && record.content === undefined && typeof record.result === 'string') {
            nextResult = { ...record, content: record.result };
        }
    }
    if (canonicalLower === 'patch') {
        nextResult = normalizeAppliedResultAliases(nextResult) ?? nextResult;
    }
    if (canonicalLower === 'glob') {
        nextResult = normalizeGlobResultForRendering(nextResult) ?? nextResult;
    }
    if (canonicalLower === 'ls') {
        nextResult = normalizeLsResultForRendering(nextResult) ?? nextResult;
    }
    if (canonicalLower === 'grep') {
        nextResult = normalizeGrepResultForRendering(nextResult) ?? nextResult;
    }
    if (canonicalLower === 'codesearch') {
        nextResult = normalizeCodeSearchResultForRendering(nextResult) ?? nextResult;
    }
    if (canonicalLower === 'reasoning') {
        nextResult = normalizeReasoningResultForRendering(nextResult) ?? nextResult;
    }
    if (canonicalLower === 'todowrite' || canonicalLower === 'todoread') {
        nextResult = normalizeTodoResultForRendering(nextResult) ?? nextResult;
    }

    return nextResult;
}

