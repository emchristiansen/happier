import { deepEqual } from '@/utils/deterministicJson';

import type { PermissionHookResponse } from './startHookServer';

type PermissionHookDecision = NonNullable<NonNullable<PermissionHookResponse['hookSpecificOutput']>['decision']>;

/** Serialize permission decisions for both SDK callbacks and local command hooks. */
export function buildClaudePermissionHookResponse(params: Readonly<{
    hookEventName: 'PermissionRequest' | 'PreToolUse';
    toolInput: unknown;
    decision: PermissionHookDecision;
}>): PermissionHookResponse {
    const { hookEventName, decision } = params;
    const message = typeof decision.message === 'string' && decision.message.length > 0
        ? decision.message : undefined;
    if (hookEventName === 'PreToolUse') {
        const updatedInput = decision.updatedInput ?? params.toolInput;
        return {
            continue: true,
            suppressOutput: true,
            hookSpecificOutput: {
                hookEventName,
                permissionDecision: decision.behavior,
                ...(decision.behavior === 'allow' && updatedInput !== undefined ? { updatedInput } : {}),
                ...(decision.behavior === 'deny' && message ? { permissionDecisionReason: message } : {}),
            },
            ...(decision.behavior === 'deny' && message ? { systemMessage: message } : {}),
        };
    }

    // Claude Code rechecks updatedInput against ask/deny rules before applying permission
    // updates. Approving the original operation must not masquerade as an input rewrite.
    const didRewriteInput = decision.updatedInput !== undefined
        && !deepEqual(decision.updatedInput, params.toolInput);
    return {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
            hookEventName,
            decision: decision.behavior === 'allow' ? {
                behavior: 'allow',
                ...(didRewriteInput ? { updatedInput: decision.updatedInput } : {}),
                ...(decision.updatedPermissions !== undefined ? { updatedPermissions: decision.updatedPermissions } : {}),
            } : {
                behavior: 'deny',
                ...(message ? { message } : {}),
                ...(decision.interrupt !== undefined ? { interrupt: decision.interrupt } : {}),
            },
        },
        ...(decision.behavior === 'deny' && message ? { systemMessage: message } : {}),
    };
}
