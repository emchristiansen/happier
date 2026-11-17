import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClaudeAppliedSettingsReader } from './readClaudeAppliedSettings';

// A stand-in for the native Claude Code executable at the process boundary. It mirrors native
// 2.1.280's observed stream-json behavior: answers `get_settings` with the model its flags and
// environment select, starts no session without a user message, and exits when stdin closes.
const FAKE_CLAUDE = `
const fs = require('node:fs');
const readline = require('node:readline');
const log = (entry) => fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(entry) + '\\n');
const args = process.argv.slice(2);
log({ kind: 'start', pid: process.pid, args, anthropicModel: process.env.ANTHROPIC_MODEL || null });
const modelIndex = args.indexOf('--model');
const model = modelIndex >= 0 ? args[modelIndex + 1] : (process.env.ANTHROPIC_MODEL ? 'claude-opus-5-5' : 'claude-opus-5-5[1m]');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  log({ kind: 'stdin', type: msg.type, subtype: msg.request && msg.request.subtype });
  if (msg.type !== 'control_request' || msg.request.subtype !== 'get_settings') return;
  if (process.env.FAKE_CLAUDE_MODE === 'exit') process.exit(0);
  const response = process.env.FAKE_CLAUDE_MODE === 'error'
    ? { request_id: msg.request_id, subtype: 'error', error: 'Unsupported control request subtype: get_settings' }
    : { request_id: msg.request_id, subtype: 'success', response: { applied: { model, effort: 'high', advisor: null, ultracode: false }, effective: {}, sources: [] } };
  process.stdout.write(JSON.stringify({ type: 'control_response', response }) + '\\n');
});
rl.on('close', () => process.exit(0));
`;

describe('createClaudeAppliedSettingsReader', () => {
    let dir: string;
    let logPath: string;
    let claudePath: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'happier-claude-applied-settings-'));
        logPath = join(dir, 'log.jsonl');
        claudePath = join(dir, 'claude.cjs');
        await writeFile(claudePath, FAKE_CLAUDE, 'utf8');
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    async function readLog(): Promise<Array<Record<string, unknown>>> {
        return (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    }

    function reader(mode: 'answer' | 'error' | 'exit', envOverlay: Record<string, string> = {}) {
        return createClaudeAppliedSettingsReader({
            cwd: dir,
            claudeCliPath: claudePath,
            javaScriptRuntime: process.execPath,
            envOverlay: { FAKE_CLAUDE_LOG: logPath, FAKE_CLAUDE_MODE: mode, ...envOverlay },
        });
    }

    it('asks the launch environment and model flags for the applied settings, then stops Claude', async () => {
        const settings = await reader('answer', { ANTHROPIC_MODEL: 'opus' })(['--agent', 'reviewer']);

        expect(settings).toMatchObject({ applied: { model: 'claude-opus-5-5', effort: 'high' } });
        const log = await readLog();
        const start = log.find((entry) => entry.kind === 'start') as { pid: number; args: string[]; anthropicModel: string | null };
        expect(start.anthropicModel).toBe('opus');
        expect(start.args).toEqual(expect.arrayContaining(['--agent', 'reviewer', '--input-format', 'stream-json']));
        expect(start.args).not.toContain('--print');
        // Only the settings request reaches Claude: no user message, so no session or model call.
        expect(log.filter((entry) => entry.kind === 'stdin')).toEqual([{ kind: 'stdin', type: 'control_request', subtype: 'get_settings' }]);
        // The enquiry process is gone once the settings are returned.
        expect(() => process.kill(start.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    });

    it('rejects with Claude Code\'s refusal', async () => {
        await expect(reader('error')([])).rejects.toThrow('Unsupported control request subtype: get_settings');
    });

    it('rejects when Claude Code exits without answering', async () => {
        await expect(reader('exit')([])).rejects.toThrow('Claude Code stopped before answering the control request');
    }, 15_000);
});
