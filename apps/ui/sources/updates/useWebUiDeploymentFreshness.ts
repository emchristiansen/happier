import * as React from 'react';
import { Platform } from 'react-native';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { reduceUiDeploymentFreshness, type UiDeploymentFreshnessState } from './uiDeploymentFreshness';

/**
 * One freshness check for the whole web app (the S-3 rule applied to the web build): every surface
 * that shows "This app" subscribes here instead of fetching the deployment identity on its own.
 * Checks on first use, on reconnect and when the tab becomes visible again.
 */
let state: UiDeploymentFreshnessState = { baselineId: null, updateAvailable: false };
let started = false;
const listeners = new Set<() => void>();

async function checkDeploymentFreshness(): Promise<void> {
    if (Platform.OS !== 'web' || typeof globalThis.fetch !== 'function') return;
    try {
        const response = await globalThis.fetch('/.well-known/happier-ui-deployment', { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok || response.status === 204) return;
        const payload = await response.json() as { deploymentId?: unknown };
        const next = reduceUiDeploymentFreshness(state, payload.deploymentId);
        if (next === state) return;
        state = next;
        for (const listener of listeners) listener();
    } catch {
        // Missing, malformed, and temporarily unavailable identities are intentionally silent.
    }
}

function start(): void {
    if (started || Platform.OS !== 'web') return;
    started = true;
    void checkDeploymentFreshness();
    apiSocket.onReconnected(() => void checkDeploymentFreshness());
    const doc = (globalThis as { document?: Document }).document;
    doc?.addEventListener('visibilitychange', () => {
        if (doc.visibilityState === 'visible') void checkDeploymentFreshness();
    });
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    start();
    return () => {
        listeners.delete(listener);
    };
}

function readUpdateAvailable(): boolean {
    return state.updateAvailable;
}

function reload(): void {
    if (Platform.OS === 'web') (globalThis as { location?: { reload?: () => void } }).location?.reload?.();
}

export function useWebUiDeploymentFreshness(): Readonly<{ updateAvailable: boolean; reload: () => void }> {
    const updateAvailable = React.useSyncExternalStore(subscribe, readUpdateAvailable, readUpdateAvailable);
    return React.useMemo(() => ({ updateAvailable, reload }), [updateAvailable]);
}
