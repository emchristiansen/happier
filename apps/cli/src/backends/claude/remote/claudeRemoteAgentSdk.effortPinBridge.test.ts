import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Query } from '@anthropic-ai/claude-agent-sdk';

import { reloadConfiguration } from '@/configuration';
import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';
import { makeMode } from './claudeRemoteAgentSdk.testkit';

type NativeSettings = { model: string; effort: string; ultracode: boolean };

/**
 * The Agent SDK query is the external boundary. This fake keeps Claude Code's observed control
 * semantics (native 2.1.280: `get_settings` → `applied`; `apply_flag_settings` acknowledges even
 * values it ignores) and records the order of controls and delivered prompts.
 */
function nativeClaude(params: Readonly<{
    settings: NativeSettings;
    ignoresApply?: boolean;
    withoutGetSettings?: boolean;
    /** Runs while the n-th `get_settings` is pending (1-based), before it is answered. */
    duringGet?: Readonly<{ n: number; run: () => Promise<void> }>;
}>) {
    const events: string[] = [];
    let gets = 0;
    const settings = { ...params.settings };
    const createQuery = (({ prompt }: { prompt: AsyncIterable<{ message: { content: unknown } }> | string }) => ({
        async *[Symbol.asyncIterator]() {
            if (typeof prompt === 'string') throw new Error('Expected streaming input');
            for await (const message of prompt) {
                const content = message.message.content as Array<{ text: string }>;
                events.push(`prompt:${content[0]?.text}`);
                yield { type: 'result' };
            }
        },
        close() {},
        async setPermissionMode() {},
        async setModel() {},
        async setMaxThinkingTokens() {},
        async supportedCommands() { return []; },
        async supportedModels() { return []; },
        ...(params.withoutGetSettings ? {} : {
            async getSettings() {
                events.push('get');
                gets += 1;
                if (params.duringGet?.n === gets) await params.duringGet.run();
                return { applied: { ...settings, advisor: null }, effective: {}, sources: [] };
            },
        }),
        async interrupt() { events.push('interrupt'); },
        async applyFlagSettings(next: Record<string, unknown>) {
            events.push(`apply:${JSON.stringify(next)}`);
            if (params.ignoresApply) return;
            if (typeof next.effortLevel === 'string') settings.effort = next.effortLevel;
            if (typeof next.ultracode === 'boolean') settings.ultracode = next.ultracode;
        },
    }) as unknown as Query);
    return { events, createQuery };
}

async function runPrompts(
    createQuery: ReturnType<typeof nativeClaude>['createQuery'],
    prompts: Array<{ text: string; model?: string }>,
    setTurnInterrupt?: (handler: (() => Promise<void>) | null) => void,
) {
    const onCompletionEvent = vi.fn();
    const onPromptTransportFailure = vi.fn();
    const queue = [...prompts];
    await claudeRemoteAgentSdk({
        sessionId: null, transcriptPath: null, path: '/tmp', claudeExecutablePath: '/tmp/claude',
        canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }), isAborted: () => false,
        nextMessage: async () => {
            const next = queue.shift();
            return next ? { message: next.text, mode: makeMode({ model: next.model }), userMessageLocalIds: [next.text] } : null;
        },
        onReady: () => {}, onSessionFound: () => {}, onMessage: () => {},
        createQuery: createQuery as never,
        onCompletionEvent, onPromptTransportFailure,
        ...(setTurnInterrupt ? { setTurnInterrupt } : {}),
    });
    return { onCompletionEvent, onPromptTransportFailure };
}

describe('claudeRemoteAgentSdk per-model effort pin bridge', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        reloadConfiguration();
    });

    function pinOpusMedium(): void {
        vi.stubEnv('HAPPIER_CLAUDE_MODEL_EFFORT_OVERRIDES', '{"claude-opus-5-5":"medium"}');
        reloadConfiguration();
    }

    it('applies and verifies the pinned effort for a natively chosen default model before the first prompt', async () => {
        pinOpusMedium();
        const native = nativeClaude({ settings: { model: 'claude-opus-5-5[1m]', effort: 'high', ultracode: false } });

        await runPrompts(native.createQuery, [{ text: 'first' }, { text: 'second' }]);

        expect(native.events).toEqual([
            'get',
            'apply:{"effortLevel":"medium","ultracode":false}',
            'get',
            'prompt:first',
            'get',
            'prompt:second',
        ]);
    });

    it('leaves a model that an alias resolves to an unpinned model untouched', async () => {
        pinOpusMedium();
        const native = nativeClaude({ settings: { model: 'claude-sonnet-5', effort: 'high', ultracode: false } });

        await runPrompts(native.createQuery, [{ text: 'first', model: 'sonnet' }]);

        expect(native.events).toEqual(['get', 'prompt:first']);
    });

    it('holds the prompt and reports explicitly when Claude Code acknowledges but does not adopt the pin', async () => {
        pinOpusMedium();
        const native = nativeClaude({ settings: { model: 'claude-opus-5-5', effort: 'high', ultracode: false }, ignoresApply: true });

        const { onCompletionEvent, onPromptTransportFailure } = await runPrompts(native.createQuery, [{ text: 'first', model: 'opus' }]);

        expect(native.events.filter((event) => event.startsWith('prompt:'))).toEqual([]);
        expect(onPromptTransportFailure).toHaveBeenCalledWith(expect.objectContaining({ kind: 'rejected_before_effect', userMessageLocalIds: ['first'] }));
        expect(onCompletionEvent.mock.calls.flat().join(' ')).toMatch(/did not adopt the pinned effort medium/);
    });

    it('holds the prompt and reports explicitly when the transport cannot read session settings', async () => {
        pinOpusMedium();
        const native = nativeClaude({ settings: { model: 'claude-opus-5-5', effort: 'high', ultracode: false }, withoutGetSettings: true });

        const { onCompletionEvent, onPromptTransportFailure } = await runPrompts(native.createQuery, [{ text: 'first' }]);

        expect(native.events).toEqual([]);
        expect(onPromptTransportFailure).toHaveBeenCalledWith(expect.objectContaining({ kind: 'rejected_before_effect' }));
        expect(onCompletionEvent.mock.calls.flat().join(' ')).toMatch(/cannot read or apply session settings/);
    });

    it('reports unsent, and never delivers, a message whose turn is interrupted while its pinned effort is checked', async () => {
        pinOpusMedium();
        let interruptTurn: (() => Promise<void>) | null = null;
        const native = nativeClaude({
            settings: { model: 'claude-opus-5-5', effort: 'medium', ultracode: false },
            // The user aborts while the accepted second message waits on its effort check.
            duringGet: { n: 2, run: async () => { await interruptTurn!(); } },
        });

        const { onPromptTransportFailure } = await runPrompts(
            native.createQuery,
            [{ text: 'FIRST' }, { text: 'CANCELLED_SECOND' }, { text: 'THIRD' }],
            (handler) => { if (handler) interruptTurn = handler; },
        );

        expect(native.events.filter((event) => event.startsWith('prompt:'))).toEqual(['prompt:FIRST', 'prompt:THIRD']);
        expect(onPromptTransportFailure).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'rejected_before_effect',
            userMessageLocalIds: ['CANCELLED_SECOND'],
        }));
    });

    it('sends no settings controls when no pin is configured', async () => {
        const native = nativeClaude({ settings: { model: 'claude-opus-5-5[1m]', effort: 'high', ultracode: false } });

        await runPrompts(native.createQuery, [{ text: 'first' }, { text: 'second' }]);

        expect(native.events).toEqual(['prompt:first', 'prompt:second']);
    });
});
