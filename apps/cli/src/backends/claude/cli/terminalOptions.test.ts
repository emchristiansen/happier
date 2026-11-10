import { describe, expect, it } from 'vitest';

import type { EnhancedMode } from '@/backends/claude/loop';
import { resolveClaudeTerminalCliOptions } from './terminalOptions';

function makeMode(overrides?: Partial<EnhancedMode>): EnhancedMode {
    return {
        permissionMode: 'default',
        ...overrides,
    };
}

describe('resolveClaudeTerminalCliOptions', () => {
    it('maps setting source subsets to Claude CLI args', () => {
        const resolved = resolveClaudeTerminalCliOptions({
            mode: makeMode({ claudeRemoteSettingSourcesV2: ['user', 'project'] }),
        });

        expect(resolved.extraArgs).toEqual(['--setting-sources', 'user,project']);
        expect(resolved.diagnostics).toEqual([]);
    });

    it('omits all-source and empty setting source overrides for the terminal CLI', () => {
        expect(resolveClaudeTerminalCliOptions({
            mode: makeMode({ claudeRemoteSettingSourcesV2: ['user', 'project', 'local'] }),
        }).extraArgs).not.toContain('--setting-sources');

        const none = resolveClaudeTerminalCliOptions({
            mode: makeMode({ claudeRemoteSettingSourcesV2: [] }),
        });

        expect(none.extraArgs).not.toContain('--setting-sources');
        expect(none.diagnostics).toEqual([
            expect.objectContaining({ code: 'unsupported_empty_setting_sources' }),
        ]);
    });

    it('maps strict MCP config when the terminal CLI supports it', () => {
        const resolved = resolveClaudeTerminalCliOptions({
            mode: makeMode({ claudeRemoteStrictMcpServerConfig: true }),
            supportsStrictMcpConfig: true,
        });

        expect(resolved.extraArgs).toContain('--strict-mcp-config');
        expect(resolved.diagnostics).toEqual([]);
    });

    it('omits strict MCP config with a diagnostic when unsupported', () => {
        const resolved = resolveClaudeTerminalCliOptions({
            mode: makeMode({ claudeRemoteStrictMcpServerConfig: true }),
            supportsStrictMcpConfig: false,
        });

        expect(resolved.extraArgs).not.toContain('--strict-mcp-config');
        expect(resolved.diagnostics).toEqual([
            expect.objectContaining({ code: 'unsupported_strict_mcp_config' }),
        ]);
    });

    it('surfaces max thinking tokens as unsupported for terminal mode', () => {
        const resolved = resolveClaudeTerminalCliOptions({
            mode: makeMode({ claudeRemoteMaxThinkingTokens: 4096 }),
        });

        expect(resolved.diagnostics).toEqual([
            expect.objectContaining({ code: 'unsupported_max_thinking_tokens' }),
        ]);
    });

    it('returns a TODO-disable system prompt addition instead of a terminal flag', () => {
        const resolved = resolveClaudeTerminalCliOptions({
            mode: makeMode({ claudeRemoteDisableTodos: true }),
        });

        expect(resolved.extraArgs).not.toContain('--tools');
        expect(resolved.appendSystemPrompt).toContain('Do not create TODO');
    });

    it('resolves ultracode only for xhigh-capable models', () => {
        expect(resolveClaudeTerminalCliOptions({
            mode: makeMode({ model: 'claude-fable-5', ultracode: true }),
        }).ultracodeSetting).toBe(true);

        expect(resolveClaudeTerminalCliOptions({
            mode: makeMode({ model: 'claude-sonnet-4-6', ultracode: true }),
        }).ultracodeSetting).toBeNull();

        expect(resolveClaudeTerminalCliOptions({
            mode: makeMode({ model: 'claude-fable-5' }),
        }).ultracodeSetting).toBeNull();
    });

    it('keeps a [1m]-suffixed model id unmutated while still resolving effort', () => {
        const resolved = resolveClaudeTerminalCliOptions({
            mode: makeMode({ model: 'claude-sonnet-4-6[1m]', reasoningEffort: 'low' }),
        });

        expect(resolved.extraArgs).toContain('--model');
        expect(resolved.extraArgs[resolved.extraArgs.indexOf('--model') + 1]).toBe('claude-sonnet-4-6[1m]');
        expect(resolved.extraArgs).toContain('--effort');
        expect(resolved.extraArgs[resolved.extraArgs.indexOf('--effort') + 1]).toBe('low');
    });

    it('uses the session effort instead of a stale launch --effort flag', () => {
        const resolved = resolveClaudeTerminalCliOptions({
            mode: makeMode({ model: 'claude-opus-5-5', reasoningEffort: 'medium' }),
            claudeArgs: ['--effort', 'high'],
        });

        expect(resolved.extraArgs.flatMap((arg, index) => arg === '--effort' ? [resolved.extraArgs[index + 1]] : []))
            .toEqual(['medium']);
    });

    it('maps terminal-compatible advanced option JSON to CLI args', () => {
        const resolved = resolveClaudeTerminalCliOptions({
            mode: makeMode({
                claudeRemoteAdvancedOptionsJson: JSON.stringify({
                    plugins: [
                        { type: 'local', path: '/tmp/plugin-a' },
                        { type: 'remote', url: 'https://example.test/plugin.zip' },
                    ],
                    betas: ['beta-a', 'beta-b'],
                    additionalDirectories: ['/tmp/extra'],
                    tools: ['Read', 'Edit'],
                    debug: true,
                    debugFile: '/tmp/claude-debug.log',
                    maxBudgetUsd: 1.5,
                }),
            }),
        });

        expect(resolved.extraArgs).toEqual([
            '--plugin-dir',
            '/tmp/plugin-a',
            '--plugin-url',
            'https://example.test/plugin.zip',
            '--betas',
            'beta-a',
            'beta-b',
            '--add-dir',
            '/tmp/extra',
            '--tools',
            'Read,Edit',
            '--debug',
            '--debug-file',
            '/tmp/claude-debug.log',
            '--max-budget-usd',
            '1.5',
        ]);
        expect(resolved.diagnostics).toEqual([]);
    });

    it('rejects Agent-SDK-only advanced option JSON keys with diagnostics', () => {
        const resolved = resolveClaudeTerminalCliOptions({
            mode: makeMode({
                claudeRemoteAdvancedOptionsJson: JSON.stringify({
                    hooks: { SessionStart: [] },
                    stderr: true,
                    permissionPromptToolName: 'AskHappier',
                    systemPrompt: 'replace system prompt',
                    sandbox: {},
                }),
            }),
        });

        expect(resolved.extraArgs).toEqual([]);
        expect(resolved.diagnostics).toHaveLength(5);
        expect(resolved.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'unsupported_advanced_option', option: 'hooks' }),
            expect.objectContaining({ code: 'unsupported_advanced_option', option: 'stderr' }),
            expect.objectContaining({ code: 'unsupported_advanced_option', option: 'permissionPromptToolName' }),
            expect.objectContaining({ code: 'unsupported_advanced_option', option: 'systemPrompt' }),
            expect.objectContaining({ code: 'unsupported_advanced_option', option: 'sandbox' }),
        ]));
    });
});
