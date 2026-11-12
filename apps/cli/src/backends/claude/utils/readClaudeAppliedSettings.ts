import { realpathSync } from 'node:fs';

import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable';
import { query } from '../sdk/query';
import type { SDKUserMessage } from '../sdk/types';
import { isClaudeCliJavaScriptFile } from './resolveClaudeCliPath';

/** Reads Claude Code's session settings for a launch with the given model-deciding flags. */
export type ClaudeAppliedSettingsReader = (modelResolutionArgs: readonly string[]) => Promise<unknown>;

/**
 * Ask the Claude Code a terminal launch will run which settings it applies, before that launch.
 *
 * Starts the same executable with the same environment in stream-json mode, sends only
 * `get_settings`, and stops it. No user message is sent, so no session starts and no model is
 * called (native 2.1.280 emits nothing besides the control response). Only flags that decide
 * the model are passed; prompts, sessions, MCP servers and plugins never are.
 */
export function createClaudeAppliedSettingsReader(params: Readonly<{
    cwd: string;
    claudeCliPath: string;
    /** Runs a JavaScript Claude entrypoint; unused for a native executable. */
    javaScriptRuntime: string | null;
    envOverlay: Readonly<Record<string, string>>;
    abort?: AbortSignal | undefined;
}>): ClaudeAppliedSettingsReader {
    return async (modelResolutionArgs) => {
        const javaScript = isClaudeCliJavaScriptFile(params.claudeCliPath);
        if (javaScript && !params.javaScriptRuntime) {
            throw new Error('No JavaScript runtime is available to start Claude Code');
        }
        const prompt = new PushableAsyncIterable<SDKUserMessage>();
        const settingsQuery = await query({
            prompt,
            options: {
                cwd: params.cwd,
                // query() selects the runtime by file extension; resolve links to the real entrypoint.
                pathToClaudeCodeExecutable: javaScript ? realpathSync(params.claudeCliPath) : params.claudeCliPath,
                ...(javaScript ? { executable: params.javaScriptRuntime! } : {}),
                env: { ...params.envOverlay },
                extraArgs: [...modelResolutionArgs],
                abort: params.abort,
            },
        });
        try {
            return await settingsQuery.getSettings();
        } finally {
            prompt.end();
            await settingsQuery.return();
        }
    };
}
