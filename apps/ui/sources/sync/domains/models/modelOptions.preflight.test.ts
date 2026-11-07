import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

import { getModelOptionsForAgentTypeOrPreflight } from './modelOptions';

describe('modelOptions preflight', () => {
    it('keeps a successful empty discovery authoritative while missing discovery uses the static fallback', () => {
        expect(getModelOptionsForAgentTypeOrPreflight({
            agentType: 'claude', preflight: { availableModels: [], supportsFreeform: true },
        }).map((row) => row.value)).toEqual(['default']);
        expect(getModelOptionsForAgentTypeOrPreflight({ agentType: 'claude', preflight: null }).length).toBeGreaterThan(1);
    });

    it('treats Grok non-freeform preflight models as authoritative', () => {
        const out = getModelOptionsForAgentTypeOrPreflight({
            agentType: 'grok',
            preflight: {
                availableModels: [{ id: 'grok-4.5', name: 'Grok 4.5' }],
                supportsFreeform: false,
            },
        });

        expect(out.map((option) => option.value)).toEqual(['default', 'grok-4.5']);
        expect(out.some((option) => option.value === 'grok-build')).toBe(false);
    });

    it('enriches advertised preflight models without adding missing catalog members', () => {
        const out = getModelOptionsForAgentTypeOrPreflight({
            agentType: 'claude',
            preflight: {
                availableModels: [
                    { id: 'claude-fable-5', name: 'Claude Fable 5' },
                    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
                    { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
                    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
                    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
                    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
                ],
                supportsFreeform: true,
            },
        });

        const modelIds = out.map((option) => option.value);
        expect(modelIds).toEqual([
            'default',
            'claude-fable-5',
            'claude-opus-4-8',
            'claude-opus-4-7',
            'claude-opus-4-6',
            'claude-sonnet-4-6',
            'claude-haiku-4-5',
        ]);

        // Dynamic capability omissions remain authoritative; the catalog only enriches copy.
        expect(out.find((option) => option.value === 'claude-fable-5')?.modelOptions).toBeUndefined();
        expect(out.find((option) => option.value === 'claude-sonnet-4-6')?.extendedContextModelId).toBeUndefined();
        expect(out.find((option) => option.value === 'claude-opus-4-6')?.description).toBeTruthy();
    });

    it('prefers preflight model list and always includes Default first', () => {
        const out = getModelOptionsForAgentTypeOrPreflight({
            agentType: 'opencode',
            preflight: {
                availableModels: [
                    { id: 'model-a', name: 'Model A' },
                    { id: 'default', name: 'Default (Agent)' },
                    { id: 'model-b', name: 'Model B', description: 'desc' },
                    { id: 'model-a', name: 'Model A (dup)' },
                ],
                supportsFreeform: false,
            },
        });

        expect(out[0]?.value).toBe('default');
        expect(out[0]?.description).toBe('');
        expect(typeof out[0]?.label).toBe('string');
        expect(String(out[0]?.label).trim().length).toBeGreaterThan(0);
        expect(out.some((o) => o.value === 'model-a')).toBe(true);
        expect(out.some((o) => o.value === 'model-b' && o.description === 'desc')).toBe(true);
        expect(out.filter((o) => o.value === 'model-a')).toHaveLength(1);
        expect(out.filter((o) => o.value === 'default')).toHaveLength(1);
    });

    it('drops malformed preflight entries and still keeps Default first', () => {
        const out = getModelOptionsForAgentTypeOrPreflight({
            agentType: 'opencode',
            preflight: {
                availableModels: [
                    { id: 'default', name: 'Default (Agent)' },
                    { id: 'valid-1', name: 'Valid 1' },
                    { id: '', name: 'Invalid empty id' },
                    { id: 'valid-2', name: 'Valid 2', description: 'desc-2' },
                    { id: 123 as unknown as string, name: 'Invalid non-string id' },
                    { id: 'missing-name', name: undefined as unknown as string },
                ],
                supportsFreeform: true,
            },
        });

        expect(out[0]?.value).toBe('default');
        expect(out[0]?.description).toBe('');
        expect(typeof out[0]?.label).toBe('string');
        expect(String(out[0]?.label).trim().length).toBeGreaterThan(0);
        expect(out.some((opt) => opt.value === 'valid-1')).toBe(true);
        expect(out.some((opt) => opt.value === 'valid-2' && opt.description === 'desc-2')).toBe(true);
        expect(out.some((opt) => opt.value === '' && opt.label === 'Invalid empty id')).toBe(true);
        expect(out.some((opt) => opt.value === 'missing-name')).toBe(false);
    });
    it('names the model id on rows a duplicate label would otherwise make indistinguishable', () => {
        const out = getModelOptionsForAgentTypeOrPreflight({
            agentType: 'claude',
            preflight: {
                availableModels: [
                    { id: 'claude-opus-4-5-20251101', name: 'Opus 4.5' },
                    { id: 'claude-opus-4-5', name: 'Opus 4.5' },
                    { id: 'claude-opus-4-6', name: 'Opus 4.6' },
                ],
                supportsFreeform: true,
            },
        });

        const pinned = out.find((option) => option.value === 'claude-opus-4-5-20251101');
        const alias = out.find((option) => option.value === 'claude-opus-4-5');
        // The pinned snapshot and its floating alias are both offered and both read "Opus 4.5",
        // so the row has to say which model id it actually selects.
        expect(pinned?.label).toBe('Opus 4.5');
        expect(alias?.label).toBe('Opus 4.5');
        expect(pinned?.description).toBe('claude-opus-4-5-20251101');
        expect(alias?.description).toBe('claude-opus-4-5');

        // A row nothing collides with keeps its curated blurb.
        const uncontested = out.find((option) => option.value === 'claude-opus-4-6');
        expect(uncontested?.description).not.toBe('claude-opus-4-6');
        expect(String(uncontested?.description).length).toBeGreaterThan(0);
    });
});
