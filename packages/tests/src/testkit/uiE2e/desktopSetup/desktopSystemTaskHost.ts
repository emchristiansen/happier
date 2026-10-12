import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Page } from '@playwright/test';

/**
 * Test-only stand-in for the desktop app's system-task bridge
 * (`apps/ui/src-tauri/src/system_tasks/{mod.rs,protocol.rs,state.rs,json_lines.rs}`).
 *
 * The Rust bridge is a thin transport: it validates the task spec envelope, spawns the bundled
 * `hsetup system-tasks run`, writes the spec and every prompt answer to its stdin as one JSON line,
 * reads JSON lines from its stdout, re-keys them to a bridge-owned task id, keeps a bounded
 * snapshot and emits `systemTasks://task/<id>/event|result` to the webview. This host does exactly
 * that for a fake-desktop Playwright page and nothing else: it makes no setup decision, never
 * answers a prompt, and never rewrites a payload beyond what the Rust serde round trip does
 * (task-id rewrite, absent optional fields serialised as `null`, lines that fail validation
 * dropped). Keep it byte-compatible with the Rust bridge; when that contract changes, change
 * this file in the same commit.
 */

export const SYSTEM_TASK_PROTOCOL_VERSION = 1;

/** `mod.rs` MAX_STDOUT_LINE_BYTES. */
const MAX_STDOUT_LINE_BYTES = 16 * 1024;
/** `state.rs` DEFAULT_MAX_EVENTS_PER_TASK / DEFAULT_MAX_STDERR_PREVIEW_BYTES. */
const MAX_EVENTS_PER_TASK = 200;
const MAX_STDERR_PREVIEW_BYTES = 4096;
/** `mod.rs` sanitize_stderr_preview MAX_CHARS. */
const MAX_STDERR_PREVIEW_CHARS = 800;

export const DESKTOP_SYSTEM_TASK_COMMANDS = [
    'start_system_task',
    'get_system_task_snapshot',
    'cancel_system_task',
    'respond_system_task_prompt',
] as const;

export type DesktopSystemTaskCommand = (typeof DESKTOP_SYSTEM_TASK_COMMANDS)[number];

/** Binding the fake Tauri bridge forwards system-task commands to (see fakeTauriDesktop.ts). */
export const DESKTOP_SYSTEM_TASK_HOST_BINDING = '__HAPPIER_FAKE_TAURI_SYSTEM_TASK_HOST__';

export type SystemTaskEvent = Readonly<{
    protocolVersion: number;
    taskId: string;
    tsMs: number;
    type: string;
    stepId: string | null;
    message: string | null;
    data: unknown;
}>;

export type SystemTaskResult =
    | Readonly<{ protocolVersion: number; taskId: string; ok: true; data: unknown }>
    | Readonly<{ protocolVersion: number; taskId: string; ok: false; error: Readonly<{ code: string; message: string }> }>;

export type SystemTaskSnapshot = Readonly<{
    events: SystemTaskEvent[];
    result: SystemTaskResult | null;
}>;

export type OutputPayload =
    | Readonly<{ kind: 'event'; event: SystemTaskEvent }>
    | Readonly<{ kind: 'result'; result: SystemTaskResult }>;

export type DesktopSystemTaskRecord = Readonly<{
    taskId: string;
    kind: string;
    params: unknown;
    /** Prompt answers the page sent, in order, exactly as written to hsetup's stdin. */
    answers: readonly string[];
    snapshot: SystemTaskSnapshot;
    cancelRequested: boolean;
    exitCode: number | null;
}>;

export type HsetupLaunch = Readonly<{
    command: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
    cwd?: string;
}>;

type Emit = (channel: string, payload: unknown) => Promise<void>;

type MutableTask = {
    taskId: string;
    kind: string;
    params: unknown;
    answers: string[];
    events: SystemTaskEvent[];
    result: SystemTaskResult | null;
    child: ChildProcessWithoutNullStreams | null;
    cancelRequested: boolean;
    stderrPreview: Buffer;
    exitCode: number | null;
    settled: Promise<void>;
};

const SPEC_KEYS = new Set(['protocolVersion', 'kind', 'params']);
const EVENT_KEYS = new Set(['protocolVersion', 'taskId', 'tsMs', 'type', 'stepId', 'message', 'data']);
const SUCCESS_KEYS = new Set(['protocolVersion', 'taskId', 'ok', 'data']);
const FAILURE_KEYS = new Set(['protocolVersion', 'taskId', 'ok', 'error']);
const ERROR_KEYS = new Set(['code', 'message']);

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
    return Object.keys(value).every((key) => allowed.has(key));
}

function isU8(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255;
}

function isU64(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** serde `Option<String>`: absent or null → None; a string → Some; anything else rejects. */
function readOptionalString(record: Record<string, unknown>, key: string): { ok: boolean; value: string | null } {
    const value = record[key];
    if (value === undefined || value === null) return { ok: true, value: null };
    return typeof value === 'string' ? { ok: true, value } : { ok: false, value: null };
}

function isBlank(value: string): boolean {
    return value.trim().length === 0;
}

/** `protocol.rs` parse_system_task_spec_json. Returns the Rust error string on rejection. */
export function parseSystemTaskSpecJson(specJson: string): { ok: true; kind: string; params: unknown } | { ok: false; error: string } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(specJson);
    } catch {
        return { ok: false, error: 'Invalid system task specification JSON.' };
    }
    if (
        !isRecord(parsed)
        || !hasOnlyKeys(parsed, SPEC_KEYS)
        || !isU8(parsed.protocolVersion)
        || typeof parsed.kind !== 'string'
        || !('params' in parsed)
    ) {
        return { ok: false, error: 'Invalid system task specification JSON.' };
    }
    if (parsed.protocolVersion !== SYSTEM_TASK_PROTOCOL_VERSION) {
        return { ok: false, error: 'Unsupported system task protocol version.' };
    }
    if (isBlank(parsed.kind)) {
        return { ok: false, error: 'System task kind is required.' };
    }
    return { ok: true, kind: parsed.kind, params: parsed.params };
}

function parseEvent(record: Record<string, unknown>): SystemTaskEvent | null {
    if (!hasOnlyKeys(record, EVENT_KEYS)) return null;
    if (!isU8(record.protocolVersion) || typeof record.taskId !== 'string' || !isU64(record.tsMs) || typeof record.type !== 'string') {
        return null;
    }
    const stepId = readOptionalString(record, 'stepId');
    const message = readOptionalString(record, 'message');
    if (!stepId.ok || !message.ok) return null;
    const event: SystemTaskEvent = {
        protocolVersion: record.protocolVersion,
        taskId: record.taskId,
        tsMs: record.tsMs,
        type: record.type,
        stepId: stepId.value,
        message: message.value,
        data: record.data === undefined ? null : record.data,
    };
    const valid = event.protocolVersion === SYSTEM_TASK_PROTOCOL_VERSION
        && !isBlank(event.taskId)
        && !isBlank(event.type)
        && (event.stepId === null || !isBlank(event.stepId))
        && (event.message === null || !isBlank(event.message));
    return valid ? event : null;
}

function parseResult(record: Record<string, unknown>): SystemTaskResult | null {
    if (typeof record.ok !== 'boolean') return null;
    if (!isU8(record.protocolVersion) || typeof record.taskId !== 'string') return null;
    if (record.protocolVersion !== SYSTEM_TASK_PROTOCOL_VERSION || isBlank(record.taskId)) return null;
    if (record.ok) {
        if (!hasOnlyKeys(record, SUCCESS_KEYS)) return null;
        return {
            protocolVersion: record.protocolVersion,
            taskId: record.taskId,
            ok: true,
            data: record.data === undefined ? null : record.data,
        };
    }
    if (!hasOnlyKeys(record, FAILURE_KEYS) || !isRecord(record.error) || !hasOnlyKeys(record.error, ERROR_KEYS)) return null;
    const { code, message } = record.error;
    if (typeof code !== 'string' || typeof message !== 'string' || isBlank(code) || isBlank(message)) return null;
    return {
        protocolVersion: record.protocolVersion,
        taskId: record.taskId,
        ok: false,
        error: { code, message },
    };
}

/** `protocol.rs` parse_output_line: a line with `ok` is a result, anything else an event. */
export function parseOutputLine(line: string): OutputPayload | null {
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch {
        return null;
    }
    if (!isRecord(value)) return null;
    if ('ok' in value) {
        const result = parseResult(value);
        return result ? { kind: 'result', result } : null;
    }
    const event = parseEvent(value);
    return event ? { kind: 'event', event } : null;
}

export function buildFailureResult(taskId: string, code: string, message: string): SystemTaskResult {
    return { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId, ok: false, error: { code, message } };
}

/** `mod.rs` sanitize_stderr_preview. */
export function sanitizeStderrPreview(bytes: Buffer): string {
    if (bytes.length === 0) return '';
    let filtered = '';
    for (const ch of bytes.toString('utf8')) {
        if (ch === '\n' || ch === '\r' || ch === '\t') {
            filtered += ch;
            continue;
        }
        if (/\p{Cc}/u.test(ch)) continue;
        filtered += ch;
    }
    const trimmed = filtered.trim();
    const chars = [...trimmed];
    if (chars.length <= MAX_STDERR_PREVIEW_CHARS) return trimmed;
    return chars.slice(chars.length - MAX_STDERR_PREVIEW_CHARS).join('').trim();
}

/** `state.rs` replaceable_acquisition_sample: byte samples of one phase replace each other. */
function isReplaceableAcquisitionSample(previous: SystemTaskEvent, next: SystemTaskEvent): boolean {
    if (next.type !== 'cli.acquisition.progress' || previous.stepId !== next.stepId) return false;
    if (!isRecord(previous.data) || !isRecord(next.data)) return false;
    return isU64(previous.data.receivedBytes)
        && isU64(next.data.receivedBytes)
        && previous.data.failure === undefined
        && next.data.failure === undefined
        && typeof previous.data.phase === 'string'
        && previous.data.phase === next.data.phase;
}

function appendEvent(task: MutableTask, event: SystemTaskEvent): void {
    if (task.result) return;
    for (let index = task.events.length - 1; index >= 0; index -= 1) {
        const previous = task.events[index];
        if (previous?.type !== 'cli.acquisition.progress') continue;
        if (isReplaceableAcquisitionSample(previous, event)) task.events.splice(index, 1);
        break;
    }
    task.events.push(event);
    if (task.events.length > MAX_EVENTS_PER_TASK) task.events.splice(0, task.events.length - MAX_EVENTS_PER_TASK);
}

function toRecord(task: MutableTask): DesktopSystemTaskRecord {
    return {
        taskId: task.taskId,
        kind: task.kind,
        params: task.params,
        answers: [...task.answers],
        snapshot: { events: [...task.events], result: task.result },
        cancelRequested: task.cancelRequested,
        exitCode: task.exitCode,
    };
}

export type DesktopSystemTaskHost = Readonly<{
    /** Handles one bridge command exactly as the Tauri command of the same name. */
    invoke: (command: DesktopSystemTaskCommand, args: Record<string, unknown> | null) => Promise<unknown>;
    /** Every task this host started, oldest first. */
    tasks: () => DesktopSystemTaskRecord[];
    /** Resolves with the task's final result (the result line or the bridge fallback). */
    waitForResult: (taskId: string) => Promise<SystemTaskResult>;
    /** Terminates every still-running hsetup child and waits for it. */
    stop: () => Promise<void>;
}>;

/**
 * Creates the transport. `launch` is the hsetup command line minus `system-tasks run`; `emit` sends
 * one Tauri event to the webview. `logPath`, when given, records every line crossing the bridge
 * so a failed scenario shows which boundary failed.
 */
export function createDesktopSystemTaskHost(params: Readonly<{
    launch: HsetupLaunch;
    emit: Emit;
    logPath?: string;
}>): DesktopSystemTaskHost {
    const tasks = new Map<string, MutableTask>();
    let nextTaskId = 0;

    const log = (line: string) => {
        if (!params.logPath) return;
        mkdirSync(dirname(params.logPath), { recursive: true });
        appendFileSync(params.logPath, `${new Date().toISOString()} ${line}\n`, 'utf8');
    };

    const emit = async (channel: string, payload: unknown) => {
        try {
            await params.emit(channel, payload);
        } catch (error) {
            // A webview that is navigating drops the event, as Tauri's emit does; the UI recovers
            // through get_system_task_snapshot. Record it so a missed event is visible in the log.
            log(`emit-failed ${channel}: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    const complete = async (task: MutableTask, result: SystemTaskResult) => {
        if (task.result) return;
        task.result = result;
        task.child = null;
        log(`result ${task.taskId} ${JSON.stringify(result)}`);
        await emit(`systemTasks://task/${task.taskId}/result`, result);
    };

    const start = (specJson: string): string => {
        const spec = parseSystemTaskSpecJson(specJson);
        if (!spec.ok) throw new Error(spec.error);

        nextTaskId += 1;
        const taskId = `system_task_${nextTaskId}`;
        let child: ChildProcessWithoutNullStreams;
        try {
            child = spawn(params.launch.command, [...params.launch.args, 'system-tasks', 'run'], {
                cwd: params.launch.cwd,
                env: params.launch.env,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch (error) {
            throw new Error(`Failed to start hsetup: ${error instanceof Error ? error.message : String(error)}`);
        }
        child.stdin.on('error', (error) => log(`stdin-error ${taskId}: ${error.message}`));
        child.stdin.write(`${specJson}\n`);
        log(`start ${taskId} kind=${spec.kind} params=${JSON.stringify(spec.params)}`);

        let resolveSettled: () => void = () => {};
        const settled = new Promise<void>((resolve) => {
            resolveSettled = resolve;
        });
        const task: MutableTask = {
            taskId,
            kind: spec.kind,
            params: spec.params,
            answers: [],
            events: [],
            result: null,
            child,
            cancelRequested: false,
            stderrPreview: Buffer.alloc(0),
            exitCode: null,
            settled,
        };
        tasks.set(taskId, task);

        let outputLimitExceeded = false;
        let stdoutDone = false;
        let pending = Buffer.alloc(0);
        let queue = Promise.resolve();
        const enqueue = (work: () => Promise<void>) => {
            queue = queue.then(work);
        };

        const handleLine = async (line: string) => {
            if (task.result || !line.trim()) return;
            log(`stdout ${taskId} ${line}`);
            const payload = parseOutputLine(line);
            if (!payload) return;
            if (payload.kind === 'event') {
                const event = { ...payload.event, taskId };
                appendEvent(task, event);
                await emit(`systemTasks://task/${taskId}/event`, event);
                return;
            }
            stdoutDone = true;
            await complete(task, { ...payload.result, taskId });
        };

        child.stdout.on('data', (chunk: Buffer) => {
            if (stdoutDone) return;
            pending = Buffer.concat([pending, chunk]);
            while (!stdoutDone) {
                const newline = pending.indexOf(0x0a);
                if (newline === -1) {
                    if (pending.length > MAX_STDOUT_LINE_BYTES) {
                        outputLimitExceeded = true;
                        stdoutDone = true;
                        child.kill('SIGTERM');
                    }
                    return;
                }
                const lineBytes = pending.subarray(0, newline + 1);
                pending = pending.subarray(newline + 1);
                if (lineBytes.length > MAX_STDOUT_LINE_BYTES) {
                    outputLimitExceeded = true;
                    stdoutDone = true;
                    child.kill('SIGTERM');
                    return;
                }
                const line = lineBytes.toString('utf8').replace(/[\r\n]+$/, '');
                enqueue(() => handleLine(line));
            }
        });
        child.stderr.on('data', (chunk: Buffer) => {
            log(`stderr ${taskId} ${chunk.toString('utf8').trimEnd()}`);
            if (task.result) return;
            const next = Buffer.concat([task.stderrPreview, chunk]);
            task.stderrPreview = next.length > MAX_STDERR_PREVIEW_BYTES ? next.subarray(next.length - MAX_STDERR_PREVIEW_BYTES) : next;
        });
        child.on('error', (error) => log(`child-error ${taskId}: ${error.message}`));
        child.on('close', (code) => {
            task.exitCode = code;
            log(`exit ${taskId} code=${String(code)}`);
            enqueue(async () => {
                if (pending.length > 0 && !stdoutDone) {
                    const line = pending.toString('utf8').replace(/[\r\n]+$/, '');
                    pending = Buffer.alloc(0);
                    await handleLine(line);
                }
                task.child = null;
                if (!task.result) {
                    await complete(task, buildFallbackResult(task, outputLimitExceeded));
                }
                resolveSettled();
            });
        });
        return taskId;
    };

    const invoke: DesktopSystemTaskHost['invoke'] = async (command, args) => {
        const taskId = String(args?.taskId ?? '');
        switch (command) {
            case 'start_system_task':
                return { taskId: start(String(args?.specJson ?? '')) };
            case 'get_system_task_snapshot': {
                const task = tasks.get(taskId);
                return task ? { events: [...task.events], result: task.result } : { events: [], result: null };
            }
            case 'cancel_system_task': {
                const task = tasks.get(taskId);
                if (!task) return null;
                task.cancelRequested = true;
                log(`cancel ${taskId}`);
                task.child?.kill('SIGTERM');
                return null;
            }
            case 'respond_system_task_prompt': {
                const task = tasks.get(taskId);
                const answerJson = String(args?.answerJson ?? '');
                if (!task?.child) return null;
                task.answers.push(answerJson);
                log(`answer ${taskId} ${answerJson}`);
                task.child.stdin.write(`${answerJson}\n`);
                return null;
            }
        }
    };

    return {
        invoke,
        tasks: () => [...tasks.values()].map(toRecord),
        async waitForResult(taskId) {
            const task = tasks.get(taskId);
            if (!task) throw new Error(`Unknown system task ${taskId}`);
            await task.settled;
            if (!task.result) throw new Error(`System task ${taskId} settled without a result`);
            return task.result;
        },
        async stop() {
            const running = [...tasks.values()].filter((task) => task.child);
            for (const task of running) task.child?.kill('SIGTERM');
            await Promise.all(running.map((task) => task.settled));
        },
    };
}

function buildFallbackResult(task: MutableTask, outputLimitExceeded: boolean): SystemTaskResult {
    if (outputLimitExceeded) {
        return buildFailureResult(task.taskId, 'output_limit_exceeded', 'System task executor exceeded the output limit.');
    }
    if (task.cancelRequested) {
        return buildFailureResult(task.taskId, 'cancelled', 'Task cancelled.');
    }
    const preview = sanitizeStderrPreview(task.stderrPreview);
    if (preview) {
        return buildFailureResult(
            task.taskId,
            'executor_ended_without_result',
            `System task executor exited without a final result.\n\nStderr (tail):\n${preview}`,
        );
    }
    return buildFailureResult(task.taskId, 'executor_ended_without_result', 'System task executor exited without a final result.');
}

/**
 * Connects a host to a page whose fake Tauri bridge was installed with
 * `installFakeTauriDesktopBridge`. Call before the first navigation: the binding and the emitter
 * survive reloads, as the Rust bridge survives webview reloads.
 */
export async function attachDesktopSystemTaskHost(
    page: Page,
    createHost: (emit: Emit) => DesktopSystemTaskHost,
): Promise<DesktopSystemTaskHost> {
    const host = createHost(async (channel, payload) => {
        await page.evaluate(
            ([eventName, eventPayload]) => {
                const emitter = (window as unknown as { __HAPPIER_FAKE_TAURI_EMIT__?: (event: string, payload: unknown) => void })
                    .__HAPPIER_FAKE_TAURI_EMIT__;
                if (!emitter) throw new Error('Fake Tauri event emitter is not installed.');
                emitter(eventName, eventPayload);
            },
            [channel, payload] as const,
        );
    });
    await page.exposeBinding(DESKTOP_SYSTEM_TASK_HOST_BINDING, async (_source, command: string, args: Record<string, unknown> | null) => {
        if (!(DESKTOP_SYSTEM_TASK_COMMANDS as readonly string[]).includes(command)) {
            throw new Error(`Unsupported system task command: ${command}`);
        }
        return await host.invoke(command as DesktopSystemTaskCommand, args);
    });
    return host;
}
