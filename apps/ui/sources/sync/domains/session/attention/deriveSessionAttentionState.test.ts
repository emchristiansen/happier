import { describe, expect, it } from 'vitest';

import { deriveSessionAttentionState } from './deriveSessionAttentionState';

const runtimeIssue = {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: 'auth_error',
    source: 'auth_error',
    occurredAt: 123,
    sanitizedPreview: 'Authentication failed',
} as const;

describe('deriveSessionAttentionState', () => {
    it('returns running for in-progress primary turns with fresh runtime evidence', () => {
        expect(deriveSessionAttentionState({
            latestTurnStatus: 'in_progress',
            lastRuntimeIssue: null,
            isRunning: true,
        })).toBe('running');
    });

    it('lets fresh running evidence override stale runtime issues', () => {
        expect(deriveSessionAttentionState({
            latestTurnStatus: 'in_progress',
            lastRuntimeIssue: runtimeIssue,
            isRunning: true,
        })).toBe('running');
    });

    it('returns failed when the latest primary turn failed with a runtime issue', () => {
        expect(deriveSessionAttentionState({
            latestTurnStatus: 'failed',
            lastRuntimeIssue: runtimeIssue,
        })).toBe('failed');
    });

    it('does not keep failed attention after a later completed turn', () => {
        expect(deriveSessionAttentionState({
            latestTurnStatus: 'completed',
            lastRuntimeIssue: runtimeIssue,
        })).toBe('idle');
    });

    it('does not keep running attention after a terminal primary turn projection without fresh runtime evidence', () => {
        expect(deriveSessionAttentionState({
            latestTurnStatus: 'completed',
            lastRuntimeIssue: null,
        })).toBe('idle');
    });

    it('does not derive running attention from in-progress projection without fresh runtime evidence', () => {
        expect(deriveSessionAttentionState({
            latestTurnStatus: 'in_progress',
            lastRuntimeIssue: null,
        })).toBe('idle');
    });

    it('derives running attention from the shared fresh runtime evidence', () => {
        expect(deriveSessionAttentionState({
            latestTurnStatus: 'in_progress',
            lastRuntimeIssue: null,
            isRunning: true,
        })).toBe('running');
    });

    it('keeps a failed primary turn visible while background work is running', () => {
        expect(deriveSessionAttentionState({
            latestTurnStatus: 'failed',
            lastRuntimeIssue: runtimeIssue,
            isRunning: true,
        })).toBe('failed');
    });
});
