import * as React from 'react';

import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import type { UnseenUpdateCompletions } from './items/buildUpdatesSummary';

/**
 * Machine update completions the person has not seen yet, per server account. This is an in-memory
 * UI projection: opening Updates for one account clears only that account's projection.
 */
let completionsByScope: ReadonlyMap<string, UnseenUpdateCompletions> = new Map();
const NO_COMPLETIONS: UnseenUpdateCompletions = new Map();
const listeners = new Set<() => void>();

function scopeKey(scope: ServerAccountScope): string {
    return serverAccountScopeKeySuffix(scope);
}

function setCompletions(scope: ServerAccountScope, next: UnseenUpdateCompletions): void {
    const all = new Map(completionsByScope);
    all.set(scopeKey(scope), next);
    completionsByScope = all;
    for (const listener of listeners) listener();
}

export function readUnseenUpdateCompletions(scope: ServerAccountScope | null): UnseenUpdateCompletions {
    return scope ? completionsByScope.get(scopeKey(scope)) ?? NO_COMPLETIONS : NO_COMPLETIONS;
}

export function recordUpdateCompleted(scope: ServerAccountScope, itemId: string, kind: 'done' | 'pendingRemote' = 'done'): void {
    const current = readUnseenUpdateCompletions(scope);
    if (current.get(itemId) === kind) return;
    const next = new Map(current);
    next.set(itemId, kind);
    setCompletions(scope, next);
}

/** Opening this server account's Updates shows every result, so nothing of it is unseen afterwards. */
export function markUpdateCompletionsSeen(scope: ServerAccountScope | null): void {
    if (!scope || readUnseenUpdateCompletions(scope).size === 0) return;
    setCompletions(scope, NO_COMPLETIONS);
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function useUnseenUpdateCompletions(scope: ServerAccountScope | null): UnseenUpdateCompletions {
    const key = scope ? scopeKey(scope) : null;
    const read = React.useCallback(
        () => (key ? completionsByScope.get(key) ?? NO_COMPLETIONS : NO_COMPLETIONS),
        [key],
    );
    return React.useSyncExternalStore(subscribe, read, read);
}
