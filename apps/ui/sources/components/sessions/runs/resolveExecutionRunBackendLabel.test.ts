import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => `t:${key}`,
    });
});

// Persisted account settings are a storage boundary, and every case here passes its catalog
// explicitly, so the store is stubbed rather than booted. This also keeps the module graph off
// the whole sync engine.
vi.mock('@/sync/domains/state/storage', () => ({
    storage: { getState: () => null },
}));

import { resolveExecutionRunBackendLabel } from './resolveExecutionRunBackendLabel';

const EMPTY_CATALOG = { v: 2 as const, backends: [] };

describe('resolveExecutionRunBackendLabel', () => {
    it('labels a built-in run backend with the localized catalog name rather than the raw agent id', () => {
        expect(resolveExecutionRunBackendLabel({ kind: 'builtInAgent', agentId: 'droid' }, EMPTY_CATALOG))
            .toBe('t:agentInput.agent.droid');
        expect(resolveExecutionRunBackendLabel({ kind: 'builtInAgent', agentId: 'agy' }, EMPTY_CATALOG))
            .toBe('t:agentInput.agent.agy');
        expect(resolveExecutionRunBackendLabel({ kind: 'builtInAgent', agentId: 'fx' }, EMPTY_CATALOG))
            .toBe('t:agentInput.agent.fx');
        expect(resolveExecutionRunBackendLabel({ kind: 'builtInAgent', agentId: 'devin' }, EMPTY_CATALOG))
            .toBe('t:agentInput.agent.devin');
        expect(resolveExecutionRunBackendLabel({ kind: 'builtInAgent', agentId: 'kimi' }, EMPTY_CATALOG))
            .toBe('t:agentInput.agent.kimi');
    });

    it('falls back to the raw id for a backend the agent catalog does not own', () => {
        expect(resolveExecutionRunBackendLabel({ kind: 'builtInAgent', agentId: 'native-review-engine' }, EMPTY_CATALOG))
            .toBe('native-review-engine');
    });

    it('keeps resolving configured ACP backends through the account catalog', () => {
        const label = resolveExecutionRunBackendLabel(
            { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            {
                v: 2,
                backends: [
                    {
                        id: 'review-bot',
                        name: 'review-bot',
                        title: 'Review Bot',
                        description: '',
                        command: 'kiro-cli',
                        args: ['acp'],
                        env: {},
                        transportProfile: 'generic',
                        defaultMode: 'plan',
                        defaultModel: 'sonnet',
                        capabilities: {
                            supportsLoadSession: false,
                            supportsModes: 'unknown',
                            supportsModels: 'unknown',
                            supportsConfigOptions: 'unknown',
                            promptImageSupport: 'unknown',
                        },
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            },
        );
        expect(label).toBe('Review Bot');
    });

    it('returns null when there is no backend target', () => {
        expect(resolveExecutionRunBackendLabel(null, EMPTY_CATALOG)).toBeNull();
    });
});
