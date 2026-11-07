import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDesktopSystemTaskHost, parseOutputLine, parseSystemTaskSpecJson } from './desktopSystemTaskHost';

/**
 * The host must speak the Rust bridge's contract byte for byte. The vectors below are the ones
 * `apps/ui/src-tauri/src/system_tasks/{protocol.rs,mod.rs}` test against, so a divergence in either
 * implementation shows up as a disagreement with the same input.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function writeFakeHsetup(script: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'desktop-system-task-host-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'hsetup.sh');
    await writeFile(path, `#!/bin/sh\n${script}`);
    await chmod(path, 0o755);
    return path;
}

function createHost(command: string) {
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    const host = createDesktopSystemTaskHost({
        launch: { command, args: [], env: process.env },
        emit: async (channel, payload) => {
            emitted.push({ channel, payload });
        },
    });
    cleanups.push(() => host.stop());
    return { host, emitted };
}

describe('desktop system task host (protocol.rs vectors)', () => {
    it('rejects specs with unknown fields', () => {
        expect(parseSystemTaskSpecJson('{"protocolVersion":1,"kind":"setup.thisComputer.v1","params":{},"extra":true}')).toEqual({
            ok: false,
            error: 'Invalid system task specification JSON.',
        });
    });

    it('parses events and serialises absent optional fields as null, like the serde round trip', () => {
        expect(parseOutputLine('{"protocolVersion":1,"taskId":"child-task","tsMs":12,"type":"progress","stepId":"install","message":"Installing"}')).toEqual({
            kind: 'event',
            event: { protocolVersion: 1, taskId: 'child-task', tsMs: 12, type: 'progress', stepId: 'install', message: 'Installing', data: null },
        });
    });

    it('rejects results with unknown fields', () => {
        expect(parseOutputLine('{"protocolVersion":1,"taskId":"child-task","ok":true,"data":{},"error":{"code":"x","message":"y"}}')).toBeNull();
    });
});

describe.runIf(process.platform !== 'win32')('desktop system task host (mod.rs behaviour)', () => {
    it('sends the spec on stdin, never argv, and rewrites child task ids to bridge-owned ids', async () => {
        const hsetup = await writeFakeHsetup([
            'IFS= read -r spec',
            'printf \'{"protocolVersion":1,"taskId":"child-task","tsMs":1,"type":"progress","message":"%s"}\\n\' "$*"',
            'printf \'{"protocolVersion":1,"taskId":"child-task","ok":true,"data":{"spec":%s}}\\n\' "$spec"',
            '',
        ].join('\n'));
        const { host, emitted } = createHost(hsetup);
        const specJson = '{"protocolVersion":1,"kind":"system.ping.v1","params":{"secret":"token"}}';

        const { taskId } = await host.invoke('start_system_task', { specJson }) as { taskId: string };
        const result = await host.waitForResult(taskId);

        expect(taskId).toBe('system_task_1');
        expect(result).toEqual({ protocolVersion: 1, taskId, ok: true, data: { spec: JSON.parse(specJson) } });
        expect(emitted.map((entry) => entry.channel)).toEqual([`systemTasks://task/${taskId}/event`, `systemTasks://task/${taskId}/result`]);
        expect(emitted[0]?.payload).toMatchObject({ taskId, message: 'system-tasks run' });
        expect(await host.invoke('get_system_task_snapshot', { taskId })).toEqual({ events: [emitted[0]?.payload], result });
    });

    it('relays a prompt answer to the running task as one stdin line', async () => {
        const hsetup = await writeFakeHsetup([
            'IFS= read -r spec || exit 2',
            'printf \'{"protocolVersion":1,"taskId":"child-task","tsMs":1,"type":"prompt","stepId":"ssh.hostTrust","message":"Trust?","data":{"kind":"ssh.trustHost"}}\\n\'',
            'IFS= read -r answer || exit 3',
            'printf \'{"protocolVersion":1,"taskId":"child-task","ok":true,"data":{"received":%s}}\\n\' "$answer"',
            '',
        ].join('\n'));
        const { host, emitted } = createHost(hsetup);

        const { taskId } = await host.invoke('start_system_task', { specJson: '{"protocolVersion":1,"kind":"remote.ssh.bootstrapMachine.v1","params":{}}' }) as { taskId: string };
        await expect.poll(() => emitted.length).toBe(1);
        await host.invoke('respond_system_task_prompt', { taskId, answerJson: '{"trusted":true}' });

        expect(await host.waitForResult(taskId)).toMatchObject({ ok: true, data: { received: { trusted: true } } });
        expect(host.tasks()[0]?.answers).toEqual(['{"trusted":true}']);
    });

    it('reports the stderr tail when the executor exits without a result', async () => {
        const hsetup = await writeFakeHsetup("IFS= read -r _spec || exit 2\nprintf 'stderr-preview: boom\\n' 1>&2\nexit 1\n");
        const { host } = createHost(hsetup);

        const { taskId } = await host.invoke('start_system_task', { specJson: '{"protocolVersion":1,"kind":"system.ping.v1","params":{}}' }) as { taskId: string };

        expect(await host.waitForResult(taskId)).toEqual({
            protocolVersion: 1,
            taskId,
            ok: false,
            error: {
                code: 'executor_ended_without_result',
                message: 'System task executor exited without a final result.\n\nStderr (tail):\nstderr-preview: boom',
            },
        });
    });
});
