import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => `t:${key}`,
    });
});

import { resolveExecutionRunLauncherBackendChoices } from './resolveExecutionRunLauncherBackendChoices';

const CATALOG_SETTINGS = { v: 2 as const, backends: [] };

describe('resolveExecutionRunLauncherBackendChoices', () => {
    it('titles built-in run backends with the localized catalog name rather than the raw agent id', () => {
        const choices = resolveExecutionRunLauncherBackendChoices({
            enabledAgentIds: ['claude', 'droid', 'fx', 'agy'],
            executionRunsBackends: {
                claude: { available: true, intents: ['run'] },
                droid: { available: true, intents: ['run'] },
                fx: { available: true, intents: ['run'] },
                agy: { available: true, intents: ['run'] },
            },
            acpCatalogSettingsV1: CATALOG_SETTINGS,
            intent: 'run',
        });

        expect(choices.map((choice) => choice.title)).toEqual([
            't:agentInput.agent.claude',
            't:agentInput.agent.droid',
            't:agentInput.agent.fx',
            't:agentInput.agent.agy',
        ]);
    });

    it('titles review engine choices with the localized catalog name', () => {
        const choices = resolveExecutionRunLauncherBackendChoices({
            enabledAgentIds: ['droid', 'fx'],
            executionRunsBackends: {
                droid: { available: true, intents: ['review'] },
                fx: { available: true, intents: ['review'] },
            },
            acpCatalogSettingsV1: CATALOG_SETTINGS,
            intent: 'review',
        });

        const byId = new Map(choices.map((choice) => [choice.builtInAgentId, choice.title]));
        expect(byId.get('droid')).toBe('t:agentInput.agent.droid');
        expect(byId.get('fx')).toBe('t:agentInput.agent.fx');
    });

    it('keeps the configured ACP backend title and leaves non-catalog engine ids untouched', () => {
        const choices = resolveExecutionRunLauncherBackendChoices({
            enabledAgentIds: ['claude', 'not-an-agent'],
            executionRunsBackends: { claude: { available: true, intents: ['run'] } },
            acpCatalogSettingsV1: {
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
            intent: 'run',
        });

        expect(choices.map((choice) => choice.title)).toEqual([
            't:agentInput.agent.claude',
            'Review Bot',
        ]);
    });
});
