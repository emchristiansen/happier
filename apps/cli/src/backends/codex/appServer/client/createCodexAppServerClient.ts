import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { StringDecoder } from 'node:string_decoder';
import { readFileSync } from 'node:fs';
import { appendFile, rename, rm, stat } from 'node:fs/promises';

import { expandHomeDirPath } from '@happier-dev/cli-common/providers';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

import { resolveCodexCliInvocation } from '../../utils/resolveCodexCliInvocation';
import { appendCodexCliConfigOverridesArgs } from '../../utils/appendCodexCliConfigOverridesArgs';
import { resolveConfiguredCodexConfigTomlPath } from '../../utils/resolveConfiguredCodexHome';
import { createCodexAppServerJsonLineReader } from './codexAppServerJsonLineReader';
import { readCodexAppServerRequestTimeoutMs } from './codexAppServerRpcTimeout';
import {
    sanitizeCodexAppServerRpcDiagnosticString,
    sanitizeCodexAppServerRpcLogValue,
} from './codexAppServerRpcLogSanitizer';
import { safeJsonStringify } from '@/utils/safeJson';
import { createCodexAppServerRpcError } from '../appServerCompatibility';
import {
    HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
    HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR } from '@/daemon/spawn/spawnExplicitEnvKeysMarker';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';

type JsonRpcMessage = Readonly<{
    id?: number | string | null;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: Readonly<{ code?: number; message?: string; data?: unknown }>;
}>;

type JsonRpcRequestHandler = (params: unknown, message: JsonRpcMessage) => Promise<unknown> | unknown;
type JsonRpcNotificationHandler = (params: unknown) => Promise<void> | void;

export type CodexAppServerRequestOptions = Readonly<{
    /** `null` preserves an in-flight provider request until it settles or the process exits. */
    timeoutMs?: number | null;
    signal?: AbortSignal;
}>;

export type CodexAppServerClient = Readonly<{
    request: (method: string, params?: unknown, options?: CodexAppServerRequestOptions) => Promise<unknown>;
    notify: (method: string, params?: unknown) => Promise<void>;
    registerRequestHandler: (method: string, handler: JsonRpcRequestHandler) => () => void;
    registerNotificationHandler: (method: string, handler: JsonRpcNotificationHandler) => () => void;
}>;

export type CodexAppServerClientDisposeOptions = Readonly<{
    pendingRequestError?: Error;
}>;

export type CodexAppServerExitHandler = (error: Error) => void | Promise<void>;

export type DisposableCodexAppServerClient = CodexAppServerClient & Readonly<{
    onExit: (handler: CodexAppServerExitHandler) => () => void;
    dispose: (options?: CodexAppServerClientDisposeOptions) => Promise<void>;
}>;

export type CodexAppServerPrivateIoEvent =
    | Readonly<{ kind: 'raw'; stream: 'stdin' | 'stdout' | 'stderr'; bytes: Uint8Array }>
    | Readonly<{ kind: 'frame'; text: string }>
    | Readonly<{ kind: 'message'; direction: 'incoming' | 'outgoing'; message: unknown }>
    | Readonly<{ kind: 'failure'; operation: string; error: unknown }>
    | Readonly<{
        kind: 'auth-record-gap'; stream: 'stdin'; writeOrdinal: number;
        reconstruction: 'payload cannot be reconstructed from this record';
    } & (
        | { operation: 'login'; method: 'account/login/start' }
        | { operation: 'refresh_result'; method: 'account/chatgptAuthTokens/refresh' }
    )>
    | Readonly<{ kind: 'malformed-auth-channel/nonrecorded'; occurrence: number; position: number }>
    | Readonly<{ kind: 'close'; code: number | null; signal: NodeJS.Signals | null }>;

type PrivateAuthRecord =
    | Readonly<{ kind: 'exact' }>
    | Readonly<{ kind: 'login-gap'; method: 'account/login/start'; reconstruction: 'payload cannot be reconstructed from this record' }>
    | Readonly<{ kind: 'refresh-result-gap'; method: 'account/chatgptAuthTokens/refresh'; reconstruction: 'payload cannot be reconstructed from this record' }>;

type PrivateNativeAuthTransport = Readonly<{
    reserveClientRequestId: () => number;
    writeSdkFrame: (input: Readonly<{ bytes: Uint8Array; recording: PrivateAuthRecord; signal: AbortSignal }>) => Promise<void>;
}>;

/** The private HOST owns SDK phases; this client owns only the one native transport. */
type PrivateSdkAuthOwner = Readonly<{
    bootstrap: (transport: PrivateNativeAuthTransport) => Promise<void>;
    routeIncoming: (line: Uint8Array) => Promise<'handled' | 'ordinary'>;
    authorizeOrdinaryWrite: (input: Readonly<{ kind: 'request' | 'notification' | 'reply'; method: string }>) => Promise<void>;
}>;

/** Captures custody synchronously; flush settles the owner's pending private writes. */
export type CodexAppServerPrivateIoOwner = Readonly<{
    capture: (event: CodexAppServerPrivateIoEvent) => void;
    flush: () => Promise<void>;
}>;

class CodexAppServerPrivateIoError extends Error {
    constructor(operation: string, readonly custodyFailed = false) {
        super(`Private Codex app-server ${operation} failed; diagnostic values are not shown`);
        this.name = 'CodexAppServerPrivateIoError';
    }
}

function privateIoFailure(owner: CodexAppServerPrivateIoOwner, operation: string, error: unknown): Error {
    if (error instanceof CodexAppServerPrivateIoError) return error;
    try {
        owner.capture({ kind: 'failure', operation, error });
    } catch {
        return new CodexAppServerPrivateIoError('failure custody', true);
    }
    return new CodexAppServerPrivateIoError(operation);
}

type CodexAppServerClientParameters = Readonly<{
    processEnv?: NodeJS.ProcessEnv;
    cwd?: string;
    configOverrides?: ReadonlyArray<string>;
    disableUserMcpServers?: boolean;
    initializeRequestOptions?: CodexAppServerRequestOptions;
    io?: Readonly<{ kind: 'ordinary' }> | Readonly<{ kind: 'private'; owner: CodexAppServerPrivateIoOwner; sdkAuth?: PrivateSdkAuthOwner }>;
}>;

type MessageQueueState = {
    fatalError: Error | null;
};

type PendingRequest = Readonly<{
    method: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
}>;

export class CodexAppServerJsonLineTooLargeError extends Error {
    readonly maxChars: number;

    constructor(maxChars: number) {
        super(`Codex app-server JSON output exceeded ${maxChars} characters before newline; refusing to buffer it`);
        this.name = 'CodexAppServerJsonLineTooLargeError';
        this.maxChars = maxChars;
    }
}

export function isCodexAppServerJsonLineTooLargeError(error: unknown): error is CodexAppServerJsonLineTooLargeError {
    return error instanceof CodexAppServerJsonLineTooLargeError;
}

type RpcLogEntry = Readonly<{
    direction: 'incoming' | 'outgoing';
    id?: number | string | null;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: Readonly<{ code?: number; message?: string; data?: unknown }> | null;
}>;

const DEFAULT_RPC_LOG_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_RPC_LOG_ROTATE_COUNT = 2;
const DEFAULT_MAX_JSON_LINE_CHARS = 128 * 1024 * 1024;

function resolveRpcLogPath(env: NodeJS.ProcessEnv): string | null {
    const raw = expandHomeDirPath(
        typeof env.HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH === 'string'
            ? env.HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH.trim()
            : '',
        env,
    );
    return raw ? raw : null;
}

function readPositiveIntegerEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
    const raw = typeof env[key] === 'string' ? env[key]?.trim() : '';
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readRpcLogMaxBytes(env: NodeJS.ProcessEnv): number {
    return readPositiveIntegerEnv(env, 'HAPPIER_CODEX_APP_SERVER_RPC_LOG_MAX_BYTES', DEFAULT_RPC_LOG_MAX_BYTES);
}

function readRpcLogRotateCount(env: NodeJS.ProcessEnv): number {
    return Math.min(
        readPositiveIntegerEnv(env, 'HAPPIER_CODEX_APP_SERVER_RPC_LOG_ROTATE_COUNT', DEFAULT_RPC_LOG_ROTATE_COUNT),
        10,
    );
}

function readMaxJsonLineChars(env: NodeJS.ProcessEnv): number {
    return readPositiveIntegerEnv(
        env,
        'HAPPIER_CODEX_APP_SERVER_MAX_JSON_LINE_CHARS',
        DEFAULT_MAX_JSON_LINE_CHARS,
    );
}

function sanitizeRpcLogError(error: RpcLogEntry['error']): RpcLogEntry['error'] {
    if (!error) return error;
    return {
        ...(typeof error.code === 'number' ? { code: error.code } : {}),
        ...(typeof error.message === 'string'
            ? { message: sanitizeCodexAppServerRpcDiagnosticString(error.message) }
            : {}),
        ...(error.data !== undefined ? { data: sanitizeCodexAppServerRpcLogValue(error.data) } : {}),
    };
}

async function rotateRpcLogIfNeeded(path: string, payload: string, maxBytes: number, rotateCount: number): Promise<void> {
    if (rotateCount <= 0) return;
    const payloadBytes = Buffer.byteLength(payload, 'utf8');
    const current = await stat(path).catch((error: unknown) => {
        if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') return null;
        throw error;
    });
    if (!current || current.size + payloadBytes <= maxBytes) return;

    await rm(`${path}.${rotateCount}`, { force: true }).catch(() => undefined);
    for (let index = rotateCount - 1; index >= 1; index -= 1) {
        await rename(`${path}.${index}`, `${path}.${index + 1}`).catch((error: unknown) => {
            if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') return;
            throw error;
        });
    }
    await rename(path, `${path}.1`).catch((error: unknown) => {
        if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') return;
        throw error;
    });
}

function createRpcLogger(env: NodeJS.ProcessEnv): {
    append: (entry: RpcLogEntry) => void;
    flush: () => Promise<void>;
} {
    const path = resolveRpcLogPath(env);
    if (!path) {
        return { append: () => undefined, flush: async () => undefined };
    }

    const maxBytes = readRpcLogMaxBytes(env);
    const rotateCount = readRpcLogRotateCount(env);
    let chain = Promise.resolve();
    const append = (entry: RpcLogEntry): void => {
        const loggedEntry: RpcLogEntry = {
            ...entry,
            params: sanitizeCodexAppServerRpcLogValue(entry.params),
            result: sanitizeCodexAppServerRpcLogValue(entry.result),
            error: sanitizeRpcLogError(entry.error),
        };
        const payload = `${safeJsonStringify(loggedEntry)}\n`;
        chain = chain
            .then(async () => {
                await rotateRpcLogIfNeeded(path, payload, maxBytes, rotateCount);
                await appendFile(path, payload, { encoding: 'utf8' });
            })
            .catch(() => undefined);
    };

    return {
        append,
        flush: async () => {
            await chain;
        },
    };
}

function failWaiters(state: MessageQueueState, error: Error): void {
    if (state.fatalError === null) {
        state.fatalError = error;
    }
}

function createJsonRpcError(message: string, code = -32000): Readonly<{ code: number; message: string }> {
    return { code, message };
}

function toMessageKey(id: number | string | null | undefined): string | null {
    if (id === null || id === undefined) return null;
    return `${typeof id}:${String(id)}`;
}

function readJsonRpcResponseIdFromLineStartSample(sample: string): number | string | null {
    let objectDepth = 0;
    let arrayDepth = 0;
    let responseId: number | string | null = null;
    let hasResponsePayload = false;
    let hasMethod = false;
    const readStringEnd = (start: number): number => {
        let escaped = false;
        for (let index = start + 1; index < sample.length; index += 1) {
            const char = sample[index];
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                return index;
            }
        }
        return -1;
    };
    for (let index = 0; index < sample.length; index += 1) {
        const char = sample[index];
        if (char === '"') {
            const end = readStringEnd(index);
            if (end < 0) break;
            if (objectDepth === 1 && arrayDepth === 0) {
                let cursor = end + 1;
                while (/\s/.test(sample[cursor] ?? '')) cursor += 1;
                if (sample[cursor] === ':') {
                    let key: unknown;
                    try {
                        key = JSON.parse(sample.slice(index, end + 1));
                    } catch {
                        return null;
                    }
                    if (key === 'method') {
                        hasMethod = true;
                    } else if (key === 'result' || key === 'error') {
                        hasResponsePayload = true;
                    } else if (key === 'id') {
                        cursor += 1;
                        while (/\s/.test(sample[cursor] ?? '')) cursor += 1;
                        if (sample[cursor] === '"') {
                            const valueEnd = readStringEnd(cursor);
                            if (valueEnd < 0) return null;
                            try {
                                const value: unknown = JSON.parse(sample.slice(cursor, valueEnd + 1));
                                responseId = typeof value === 'string' ? value : null;
                            } catch {
                                return null;
                            }
                        } else {
                            const numberMatch = /^-?\d+/.exec(sample.slice(cursor));
                            if (!numberMatch) return null;
                            const value = Number(numberMatch[0]);
                            responseId = Number.isSafeInteger(value) ? value : null;
                        }
                    }
                }
            }
            index = end;
        } else if (char === '{') objectDepth += 1;
        else if (char === '}') objectDepth -= 1;
        else if (char === '[') arrayDepth += 1;
        else if (char === ']') arrayDepth -= 1;
    }
    return hasResponsePayload && !hasMethod ? responseId : null;
}

function createDisposedError(): Error {
    return new Error('Codex app-server client has been disposed');
}

function resolveRequestTimeoutMs(defaultTimeoutMs: number | null, options?: CodexAppServerRequestOptions): number | null {
    if (options?.timeoutMs === null) {
        return null;
    }
    if (options?.timeoutMs === undefined) {
        return defaultTimeoutMs;
    }
    const override = Math.trunc(options.timeoutMs);
    return Number.isFinite(override) && override > 0 ? Math.max(250, override) : defaultTimeoutMs;
}

function sanitizeCodexAppServerEnv(processEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return {
        ...processEnv,
        CODEX_THREAD_ID: undefined,
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: undefined,
        HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH: undefined,
        HAPPIER_CODEX_APP_SERVER_RPC_LOG_MAX_BYTES: undefined,
        HAPPIER_CODEX_APP_SERVER_RPC_LOG_ROTATE_COUNT: undefined,
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: undefined,
        [HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]: undefined,
        [HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR]: undefined,
    };
}

function resolveCodexConfigTomlPath(env: NodeJS.ProcessEnv): string {
    return resolveConfiguredCodexConfigTomlPath(env);
}

function normalizeCodexMcpServerKeyFromConfigSection(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    const firstChar = trimmed[0];
    if (firstChar === '"' || firstChar === "'") {
        const end = trimmed.indexOf(firstChar, 1);
        if (end === -1) return null;
        return trimmed.slice(0, end + 1);
    }

    const firstSegment = trimmed.split('.')[0]?.trim() ?? '';
    return firstSegment ? firstSegment : null;
}

function readCodexMcpServerKeysFromConfigToml(env: NodeJS.ProcessEnv): string[] {
    const configPath = resolveCodexConfigTomlPath(env);
    let text: string;
    try {
        text = readFileSync(configPath, 'utf8');
    } catch {
        return [];
    }

    const keys = new Set<string>();
    const re = /^\s*\[mcp_servers\.([^\]]+)\]\s*$/gm;
    for (;;) {
        const match = re.exec(text);
        if (!match) break;
        const key = normalizeCodexMcpServerKeyFromConfigSection(match[1] ?? '');
        if (!key) continue;
        keys.add(key);
    }

    return Array.from(keys).sort((a, b) => a.localeCompare(b));
}

export async function createCodexAppServerClient(params: CodexAppServerClientParameters): Promise<DisposableCodexAppServerClient> {
    // This installs an I/O edge only. It does not qualify readers, launch origin or an audience.
    const selectedOwner = params.io?.kind === 'private' ? params.io.owner : null;
    if (params.io?.kind === 'private' && (
        !selectedOwner || typeof selectedOwner.capture !== 'function' || typeof selectedOwner.flush !== 'function'
    )) {
        throw new CodexAppServerPrivateIoError('owner construction');
    }
    if (params.io?.kind === 'private' && params.io.sdkAuth !== undefined && (
        !params.io.sdkAuth || typeof params.io.sdkAuth.bootstrap !== 'function'
        || typeof params.io.sdkAuth.routeIncoming !== 'function' || typeof params.io.sdkAuth.authorizeOrdinaryWrite !== 'function'
    )) throw new CodexAppServerPrivateIoError('SDK owner construction');
    let flushPromise: Promise<void> | null = null;
    const privateOwner = selectedOwner ? {
        capture: selectedOwner.capture.bind(selectedOwner),
        flush: () => flushPromise ??= Promise.resolve().then(() => selectedOwner.flush()),
    } : null;
    try {
        return await createOwnedCodexAppServerClient(params, privateOwner);
    } catch (error) {
        if (!privateOwner) throw error;
        const failure = privateIoFailure(privateOwner, 'construction', error);
        try {
            await privateOwner.flush();
        } catch (flushError) {
            throw privateIoFailure(privateOwner, 'construction flush', flushError);
        }
        throw failure;
    }
}

async function createOwnedCodexAppServerClient(
    params: CodexAppServerClientParameters,
    privateOwner: CodexAppServerPrivateIoOwner | null,
): Promise<DisposableCodexAppServerClient> {
    const sdkAuth = params.io?.kind === 'private' ? params.io.sdkAuth : undefined;
    let sdkReady = sdkAuth === undefined;
    let privateCustodyFailure: Error | null = null;
    const audienceFailure = (operation: string, error: unknown): Error => {
        const failure = privateOwner
            ? privateIoFailure(privateOwner, operation, error)
            : error instanceof Error ? error : new Error(String(error));
        if (failure instanceof CodexAppServerPrivateIoError && failure.custodyFailed) {
            privateCustodyFailure ??= failure;
        }
        return failure;
    };
    const capturePrivate = (event: CodexAppServerPrivateIoEvent): void => {
        if (!privateOwner) return;
        try {
            privateOwner.capture(event);
        } catch (error) {
            privateCustodyFailure ??= audienceFailure('capture', error);
            throw privateCustodyFailure;
        }
        // A synchronous owner callback can reenter this client and fail nested custody.
        if (privateCustodyFailure) throw privateCustodyFailure;
    };
    const sourceProcessEnv = params.processEnv ?? process.env;
    const rpcLogger = privateOwner ? null : createRpcLogger(sourceProcessEnv);
    const processEnv = sanitizeCodexAppServerEnv(sourceProcessEnv);
    const baseInvocation = await resolveCodexCliInvocation({
        args: ['app-server', '--listen', 'stdio://'],
        cwd: params.cwd,
        processEnv,
        overrideEnvVarKeys: ['HAPPIER_CODEX_APP_SERVER_BIN', 'HAPPIER_CODEX_TUI_BIN', 'HAPPY_CODEX_TUI_BIN'],
        targetLabel: 'Codex app-server',
    });

    const baseOverrides = params.disableUserMcpServers === true
        ? readCodexMcpServerKeysFromConfigToml(processEnv).map((key) => `mcp_servers.${key}.enabled=false`)
        : [];

    const invocation = appendCodexCliConfigOverridesArgs(baseInvocation, [...baseOverrides, ...(params.configOverrides ?? [])]);
    const windowsInvocation = resolveWindowsCommandInvocation({
        command: invocation.command,
        args: invocation.args,
        resolveCommandOnPath: true,
    });
    const child = spawn(windowsInvocation.command, windowsInvocation.args, {
        cwd: params.cwd ?? process.cwd(),
        env: processEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: windowsInvocation.windowsVerbatimArguments,
    });

    if (!child.stdin || !child.stdout || !child.stderr) {
        throw new Error('Failed to start Codex app-server with piped stdio');
    }

    const state: MessageQueueState = {
        fatalError: null,
    };
    let stderrBuffer = '';
    const maxStderrChars = 8_000;
    const pendingRequests = new Map<string, PendingRequest>();
    const requestHandlers = new Map<string, JsonRpcRequestHandler>();
    const notificationHandlers = new Map<string, Set<JsonRpcNotificationHandler>>();
    const exitHandlers = new Set<CodexAppServerExitHandler>();
    let reportedExitFailure: Error | null = null;
    let writeChain = Promise.resolve();
    let incomingChain = Promise.resolve();
    let incomingBytes = Buffer.alloc(0);
    let writeOrdinal = 0;
    let nextId = 0;
    let disposing = false;
    let disposePromise: Promise<void> | null = null;
    const privateCallbackContext = privateOwner ? new AsyncLocalStorage<{ active: boolean }>() : null;
    const privateCallbackTasks = new Set<Promise<void>>();
    let resolveClosed: (() => void) | null = null;
    const closedPromise = new Promise<void>((resolve) => {
        resolveClosed = resolve;
    });

    const invokePrivateCallback = <T>(callback: () => T | Promise<T>): T | Promise<T> => {
        if (!privateCallbackContext) return callback();
        const context = { active: true };
        try {
            const result = privateCallbackContext.run(context, callback);
            if (result && typeof (result as PromiseLike<T>).then === 'function') {
                return Promise.resolve(result).finally(() => { context.active = false; });
            }
            context.active = false;
            return result;
        } catch (error) {
            context.active = false;
            throw error;
        }
    };

    const runPrivateCallbackTask = (operation: () => Promise<void>, onFailure: (error: unknown) => void): void => {
        if (disposing) return;
        const task = (async () => {
            try { await operation(); }
            catch (error) { onFailure(error); }
        })();
        privateCallbackTasks.add(task);
        void task.then(() => { privateCallbackTasks.delete(task); });
    };

    const assertPrivateWorkAdmission = (): void => {
        // Reuse the recorded disposal failure; registering after the final flush adds no new event.
        if (privateOwner && disposing) throw state.fatalError ?? new CodexAppServerPrivateIoError('work admission');
    };

    const failPendingRequests = (error: Error): void => {
        for (const [requestKey, pending] of pendingRequests.entries()) {
            pendingRequests.delete(requestKey);
            pending.reject(error);
        }
    };

    const queueWrite = async (payload: string | Buffer, capture: (ordinal: number) => void, signal?: AbortSignal): Promise<void> => {
        const nextWrite = writeChain.then(async () => {
            // A queued write must not outlive a failure while capturing another message.
            if (privateCustodyFailure) throw privateCustodyFailure;
            if (sdkAuth && state.fatalError) throw state.fatalError;
            if (signal && (signal.aborted || state.fatalError)) throw state.fatalError ?? new CodexAppServerPrivateIoError('SDK write aborted');
            if (privateOwner && disposing) throw state.fatalError ?? new CodexAppServerPrivateIoError('write after disposal');
            const stdin = child.stdin;
            if (!stdin || stdin.writableEnded || stdin.destroyed) {
                throw state.fatalError ?? createDisposedError();
            }
            await new Promise<void>((resolve, reject) => {
                const onAbort = () => reject(new CodexAppServerPrivateIoError('SDK write aborted'));
                signal?.addEventListener('abort', onAbort, { once: true });
                const cleanup = () => signal?.removeEventListener('abort', onAbort);
                try {
                    capture(++writeOrdinal);
                    if (privateOwner && disposing) throw state.fatalError ?? new CodexAppServerPrivateIoError('write after disposal');
                    if (signal?.aborted) throw new CodexAppServerPrivateIoError('SDK write aborted');
                    stdin.write(payload, 'utf8', (error) => {
                        cleanup();
                        if (error) {
                            reject(error);
                            return;
                        }
                        // Only this original child's complete callback can release
                        // SDK write ownership. Close, abort or custody failure wins.
                        if (signal && (signal.aborted || disposing || state.fatalError || privateCustodyFailure || stdin.destroyed || stdin.writableEnded)) {
                            reject(state.fatalError ?? privateCustodyFailure ?? new CodexAppServerPrivateIoError('SDK write lost ownership'));
                            return;
                        }
                        resolve();
                    });
                } catch (error) {
                    cleanup();
                    reject(error);
                }
            });
        });
        writeChain = nextWrite.catch(() => undefined);
        try {
            await nextWrite;
        } catch (error) {
            throw audienceFailure('write', error);
        }
    };

    const sendMessage = async (message: Record<string, unknown>, replyMethod?: string): Promise<void> => {
        if (privateCustodyFailure) throw privateCustodyFailure;
        if (state.fatalError) throw state.fatalError;
        if (sdkAuth) {
            try {
                if (!sdkReady) throw new CodexAppServerPrivateIoError('ordinary write before SDK bootstrap');
                const method = typeof message.method === 'string' ? message.method : replyMethod;
                if (!method) throw new CodexAppServerPrivateIoError('unbound ordinary reply');
                await sdkAuth.authorizeOrdinaryWrite({
                    kind: typeof message.method === 'string' ? message.id === undefined ? 'notification' : 'request' : 'reply',
                    method,
                });
            } catch (error) {
                failWith(error, { operation: 'ordinary SDK authorization' });
                throw state.fatalError;
            }
            if (state.fatalError || privateCustodyFailure || disposing) throw state.fatalError ?? privateCustodyFailure ?? createDisposedError();
        }
        capturePrivate({ kind: 'message', direction: 'outgoing', message });
        rpcLogger?.append({
            direction: 'outgoing', id: (message as JsonRpcMessage).id ?? null,
            method: (message as JsonRpcMessage).method, params: (message as JsonRpcMessage).params ?? null,
            result: (message as JsonRpcMessage).result ?? null, error: ((message as JsonRpcMessage).error as RpcLogEntry['error']) ?? null,
        });
        let payload: string;
        try { payload = `${safeJsonStringify(message)}\n`; }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const method = typeof message.method === 'string' ? message.method : 'notification';
            throw privateOwner ? audienceFailure('serialization', error) : new Error(`Failed to serialize Codex app-server ${method} message: ${reason}`);
        }
        await queueWrite(payload, () => capturePrivate({ kind: 'raw', stream: 'stdin', bytes: Buffer.from(payload, 'utf8') }));
    };

    const authTransport: PrivateNativeAuthTransport = {
        reserveClientRequestId: () => {
            if (disposing || state.fatalError || privateCustodyFailure || nextId >= Number.MAX_SAFE_INTEGER) {
                throw state.fatalError ?? privateCustodyFailure ?? new CodexAppServerPrivateIoError('SDK request ID allocation');
            }
            return ++nextId;
        },
        writeSdkFrame: async ({ bytes, recording, signal }) => {
            try {
                if (!sdkAuth || !privateOwner) throw new CodexAppServerPrivateIoError('SDK write without owner');
                // Copy the owned full line before queuing; do not parse or re-encode
                // directional IDs or inspect payloads to choose record treatment.
                const payload = Buffer.from(bytes);
                if (payload.length === 0 || payload[payload.length - 1] !== 10 || payload.subarray(0, -1).includes(10)) {
                    throw new CodexAppServerPrivateIoError('incomplete SDK frame');
                }
                await queueWrite(payload, (ordinal) => {
                    switch (recording.kind) {
                        case 'exact': capturePrivate({ kind: 'raw', stream: 'stdin', bytes: Buffer.from(payload) }); break;
                        case 'login-gap':
                            capturePrivate({ kind: 'auth-record-gap', stream: 'stdin', writeOrdinal: ordinal,
                                operation: 'login', method: 'account/login/start', reconstruction: 'payload cannot be reconstructed from this record' });
                            break;
                        case 'refresh-result-gap':
                            capturePrivate({ kind: 'auth-record-gap', stream: 'stdin', writeOrdinal: ordinal,
                                operation: 'refresh_result', method: 'account/chatgptAuthTokens/refresh', reconstruction: 'payload cannot be reconstructed from this record' });
                            break;
                        default: throw new CodexAppServerPrivateIoError('unknown SDK recording operation');
                    }
                }, signal);
            } catch (error) {
                failWith(error, { operation: 'SDK native write' });
                throw state.fatalError;
            }
        },
    };

    const handleServerRequest = async (message: JsonRpcMessage): Promise<void> => {
        if (typeof message.method !== 'string') return;
        const requestKey = toMessageKey(message.id);
        if (!requestKey) return;
        const handler = requestHandlers.get(message.method);
        if (!handler) {
            await sendMessage({
                id: message.id,
                error: createJsonRpcError(`No handler registered for ${message.method}`, -32601),
            }, message.method);
            return;
        }
        try {
            const result = await (privateOwner
                ? invokePrivateCallback(() => handler(message.params, message))
                : handler(message.params, message));
            await sendMessage({ id: message.id, result: result ?? null }, message.method);
        } catch (error) {
            if (privateOwner) audienceFailure('request handler', error);
            const failure = error instanceof Error ? error : new Error(String(error));
            await sendMessage({
                id: message.id,
                error: createJsonRpcError(failure.message),
            }, message.method);
        }
    };

    const reportExit = (failure: Error): void => {
        if (reportedExitFailure || disposing) return;
        reportedExitFailure = failure;
        for (const handler of [...exitHandlers]) {
            if (privateOwner) {
                runPrivateCallbackTask(
                    async () => { await invokePrivateCallback(() => handler(failure)); },
                    (error) => { audienceFailure('exit handler', error); },
                );
            } else {
                void Promise.resolve(handler(failure)).catch(() => undefined);
            }
        }
    };

    let terminateChildPromise: Promise<void> | null = null;
    const terminateChild = (): Promise<void> => {
        if (terminateChildPromise) return terminateChildPromise;
        // Snapshot and terminate descendants before closing stdio. Ending stdin first can let a
        // JavaScript launcher exit and re-parent its native Codex child before the tree walk.
        terminateChildPromise = killProcessTree(child, { graceMs: 250 }).catch((error) => {
            if (privateOwner) throw audienceFailure('process disposal', error);
        });
        return terminateChildPromise;
    };

    const failWith = (error: unknown, options?: Readonly<{ terminateChild?: boolean; operation?: string }>): void => {
        const failure = audienceFailure(options?.operation ?? 'process', error);
        failWaiters(state, failure);
        const fatalFailure = state.fatalError ?? failure;
        failPendingRequests(fatalFailure);
        reportExit(fatalFailure);
        if (options?.terminateChild === false || disposing) return;
        void terminateChild().catch((error) => {
            failWith(error, { terminateChild: false, operation: 'process disposal' });
        });
    };

    const handleIncomingMessage = (message: JsonRpcMessage): void => {
        capturePrivate({ kind: 'message', direction: 'incoming', message });
        rpcLogger?.append({
            direction: 'incoming',
            id: message.id ?? null,
            method: message.method,
            params: message.params ?? null,
            result: message.result ?? null,
            error: message.error ?? null,
        });
        const requestKey = toMessageKey(message.id);
        if (typeof message.method === 'string') {
            if (requestKey) {
                if (privateOwner) runPrivateCallbackTask(() => handleServerRequest(message), (error) => { failWith(error); });
                else void handleServerRequest(message).catch((error) => { failWith(error); });
                return;
            }
            const handlers = notificationHandlers.get(message.method);
            if (handlers && handlers.size > 0) {
                for (const handler of [...handlers]) {
                    if (privateOwner) {
                        runPrivateCallbackTask(
                            async () => { await invokePrivateCallback(() => handler(message.params)); },
                            (error) => { failWith(error); },
                        );
                        continue;
                    }
                    try {
                        const result = handler(message.params);
                        if (result && typeof (result as PromiseLike<void>).then === 'function') {
                            void Promise.resolve(result).catch((error: unknown) => {
                                failWith(error);
                            });
                        }
                    } catch (error) {
                        failWith(error);
                    }
                }
            }
            return;
        }
        if (!requestKey) {
            return;
        }
        const pending = pendingRequests.get(requestKey);
        if (!pending) {
            return;
        }
        pendingRequests.delete(requestKey);
        if (message.error) {
            pending.reject(createCodexAppServerRpcError({
                method: pending.method,
                code: message.error.code,
                message: message.error.message,
                data: message.error.data,
            }));
            return;
        }
        pending.resolve(message.result);
    };

    const rejectCorrelatedJsonLine = (sample: string, error: Error): boolean => {
        const requestKey = toMessageKey(readJsonRpcResponseIdFromLineStartSample(sample));
        if (requestKey) {
            const pending = pendingRequests.get(requestKey);
            if (pending) {
                pendingRequests.delete(requestKey);
                pending.reject(error);
                return true;
            }
        }
        return false;
    };

    const handleOversizedJsonLine = (sample: string, maxBufferedChars: number): void => {
        const error = audienceFailure('oversized frame', new CodexAppServerJsonLineTooLargeError(maxBufferedChars));
        if (rejectCorrelatedJsonLine(sample, error)) return;
        failWith(error);
    };

    const jsonLineReader = createCodexAppServerJsonLineReader(
        (rawLine) => {
            if (state.fatalError) return;
            try {
                capturePrivate({ kind: 'frame', text: rawLine });
                handleIncomingMessage(JSON.parse(rawLine) as JsonRpcMessage);
            } catch (error) {
                const failure = privateOwner ? audienceFailure('frame parsing', error)
                    : new Error(`Invalid Codex app-server JSON output: ${error instanceof Error ? error.message : String(error)}`);
                if (rejectCorrelatedJsonLine(rawLine, failure)) return;
                failWith(failure);
            }
        },
        {
            maxBufferedChars: readMaxJsonLineChars(sourceProcessEnv),
            onOversizedLine: handleOversizedJsonLine,
        },
    );

    child.stdin.on('error', (error) => {
        failWith(error, { operation: 'stdin' });
    });
    // Private capture sees original bytes before UTF-8 decoding or JSON framing.
    const stdoutDecoder = privateOwner ? new StringDecoder('utf8') : null;
    if (!privateOwner) child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: Buffer | string) => {
        try {
            if (privateOwner) capturePrivate({ kind: 'raw', stream: 'stdout', bytes: Buffer.from(chunk) });
            if (state.fatalError) return;
            if (sdkAuth) {
                incomingBytes = Buffer.concat([incomingBytes, Buffer.from(chunk)]);
                let newline: number;
                while ((newline = incomingBytes.indexOf(10)) !== -1) {
                    const line = Buffer.from(incomingBytes.subarray(0, newline + 1));
                    incomingBytes = incomingBytes.subarray(newline + 1);
                    if (line.length > readMaxJsonLineChars(sourceProcessEnv)) throw new CodexAppServerJsonLineTooLargeError(readMaxJsonLineChars(sourceProcessEnv));
                    // Keep full signed-i64/string IDs and original bytes outside
                    // JSON.parse until the SDK owner explicitly returns Other.
                    const route = incomingChain.then(async () => {
                        if (state.fatalError || disposing) return;
                        const result = await sdkAuth.routeIncoming(line);
                        if (result === 'ordinary') jsonLineReader.push(stdoutDecoder!.write(line));
                        else if (result !== 'handled') throw new CodexAppServerPrivateIoError('invalid SDK route');
                    });
                    incomingChain = route.catch((error) => { failWith(error, { operation: 'SDK incoming route' }); });
                }
                if (incomingBytes.length > readMaxJsonLineChars(sourceProcessEnv)) throw new CodexAppServerJsonLineTooLargeError(readMaxJsonLineChars(sourceProcessEnv));
                return;
            }
            jsonLineReader.push(stdoutDecoder ? stdoutDecoder.write(Buffer.from(chunk)) : chunk as string);
        } catch (error) {
            failWith(privateOwner ? error : new Error(`Invalid Codex app-server JSON output: ${error instanceof Error ? error.message : String(error)}`), { operation: 'stdout' });
        }
    });
    if (!privateOwner) child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: Buffer | string) => {
        if (privateOwner) {
            try {
                capturePrivate({ kind: 'raw', stream: 'stderr', bytes: Buffer.from(chunk) });
            } catch (error) {
                failWith(error, { operation: 'stderr' });
            }
            return;
        }
        if (stderrBuffer.length >= maxStderrChars) return;
        stderrBuffer = (stderrBuffer + chunk).slice(0, maxStderrChars);
    });
    if (privateOwner) {
        child.stdout.on('error', (error) => failWith(error, { operation: 'stdout' }));
        child.stderr.on('error', (error) => failWith(error, { operation: 'stderr' }));
    }
    child.once('error', (error) => {
        failWith(privateOwner ? error : new Error(`Failed to launch Codex app-server: ${error.message}`), { operation: 'launch' });
    });
    child.once('close', (code, signal) => {
        resolveClosed?.();
        try {
            capturePrivate({ kind: 'close', code, signal });
        } catch (error) {
            failWith(error, { terminateChild: false, operation: 'close custody' });
        }
        if (disposing) {
            return;
        }
        const suffix = !privateOwner && stderrBuffer.trim()
            ? `\n${sanitizeCodexAppServerRpcDiagnosticString(stderrBuffer.trim())}`
            : '';
        const failure = new Error(`Codex app-server exited before completing the request (code=${code ?? 'null'} signal=${signal ?? 'null'})${suffix}`);
        failWith(failure, { terminateChild: false, operation: 'exit' });
    });

    const request = async (
        method: string,
        requestParams?: unknown,
        requestOptions?: CodexAppServerRequestOptions,
    ): Promise<unknown> => {
        const signal = requestOptions?.signal;
        if (signal?.aborted) {
            const error = new Error('Codex app-server request aborted');
            error.name = 'AbortError';
            throw error;
        }
        const timeoutMs = resolveRequestTimeoutMs(
            readCodexAppServerRequestTimeoutMs(method, processEnv),
            requestOptions,
        );
        const id = ++nextId;
        const requestKey = toMessageKey(id);
        if (!requestKey) {
            throw new Error(`Failed to create Codex app-server request id for ${method}`);
        }
        let onAbort: (() => void) | null = null;
        const responsePromise = new Promise<unknown>((resolve, reject) => {
            const cleanup = () => {
                if (onAbort) signal?.removeEventListener('abort', onAbort);
            };
            const timer = timeoutMs === null
                ? null
                : setTimeout(() => {
                    pendingRequests.delete(requestKey);
                    cleanup();
                    reject(new Error(`Codex app-server request ${method} timed out after ${timeoutMs}ms`));
                }, timeoutMs);
            pendingRequests.set(requestKey, {
                method,
                resolve: (value) => {
                    if (timer !== null) clearTimeout(timer);
                    cleanup();
                    resolve(value);
                },
                reject: (error) => {
                    if (timer !== null) clearTimeout(timer);
                    cleanup();
                    reject(error);
                },
            });
            onAbort = () => {
                const pending = pendingRequests.get(requestKey);
                if (!pending) return;
                pendingRequests.delete(requestKey);
                const error = new Error(`Codex app-server request ${method} aborted`);
                error.name = 'AbortError';
                pending.reject(error);
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) onAbort();
        });
        if (!signal?.aborted) {
            // Observe the response immediately: a blocked pipe must not hide timeout,
            // cancellation, or child-exit settlement while its write callback is pending.
            void sendMessage({
                id,
                method,
                // Codex app-server rejects requests that omit the `params` field entirely.
                params: requestParams === undefined ? {} : requestParams,
            }).catch((error: unknown) => {
                const failure = error instanceof Error ? error : new Error(String(error));
                const pending = pendingRequests.get(requestKey);
                pendingRequests.delete(requestKey);
                pending?.reject(failure);
            });
        }
        return await responsePromise;
    };

    const notify = async (method: string, notificationParams?: unknown): Promise<void> => {
        await sendMessage({
            method,
            // Codex app-server rejects notifications that omit the `params` field entirely.
            params: notificationParams === undefined ? {} : notificationParams,
        });
    };

    const registerRequestHandler = (method: string, handler: JsonRpcRequestHandler): (() => void) => {
        assertPrivateWorkAdmission();
        requestHandlers.set(method, handler);
        return () => {
            if (requestHandlers.get(method) === handler) {
                requestHandlers.delete(method);
            }
        };
    };

    const registerNotificationHandler = (method: string, handler: JsonRpcNotificationHandler): (() => void) => {
        assertPrivateWorkAdmission();
        const existing = notificationHandlers.get(method);
        if (existing) {
            existing.add(handler);
        } else {
            notificationHandlers.set(method, new Set([handler]));
        }
        return () => {
            const handlers = notificationHandlers.get(method);
            if (!handlers) return;
            handlers.delete(handler);
            if (handlers.size === 0) {
                notificationHandlers.delete(method);
            }
        };
    };

    const dispose = async (options?: CodexAppServerClientDisposeOptions): Promise<void> => {
        // This check precedes memoized disposal: waiting from an owned callback would wait on itself.
        if (privateCallbackContext?.getStore()?.active) {
            throw audienceFailure('reentrant disposal', new Error('Cannot dispose the private Codex app-server from its active callback'));
        }
        if (disposePromise) {
            return await disposePromise;
        }
        disposing = true;
        const beginDisposal = (): Promise<void> => {
            const disposedError = privateOwner
                ? audienceFailure('disposal', options?.pendingRequestError ?? createDisposedError())
                : options?.pendingRequestError ?? createDisposedError();
            failWaiters(state, disposedError);
            failPendingRequests(disposedError);
            return (async () => {
                try {
                    await terminateChild();
                    await closedPromise;
                    if (privateOwner) {
                        await incomingChain;
                        await Promise.all(privateCallbackTasks);
                        await writeChain;
                    }
                    if (privateCustodyFailure) throw privateCustodyFailure;
                } finally {
                    if (privateOwner) {
                        try {
                            await privateOwner.flush();
                        } catch (error) {
                            throw audienceFailure('disposal flush', error);
                        }
                    } else {
                        await rpcLogger?.flush().catch(() => undefined);
                    }
                }
            })();
        };
        if (privateOwner) {
            // Install completion before owner.capture can synchronously reenter disposal.
            let startDisposal!: () => void;
            disposePromise = new Promise<void>((resolve, reject) => {
                startDisposal = () => {
                    try { resolve(beginDisposal()); }
                    catch (error) { reject(error); }
                };
            });
            startDisposal();
        } else {
            disposePromise = beginDisposal();
        }
        return await disposePromise;
    };

    const onExit = (handler: CodexAppServerExitHandler): (() => void) => {
        assertPrivateWorkAdmission();
        if (reportedExitFailure) {
            if (privateOwner) {
                const failure = reportedExitFailure;
                runPrivateCallbackTask(
                    async () => { await invokePrivateCallback(() => handler(failure)); },
                    (error) => { audienceFailure('exit handler', error); },
                );
            } else {
                void Promise.resolve(handler(reportedExitFailure)).catch(() => undefined);
            }
            return () => undefined;
        }
        exitHandlers.add(handler);
        return () => {
            exitHandlers.delete(handler);
        };
    };

    try {
        if (sdkAuth) {
            await sdkAuth.bootstrap(authTransport);
            if (state.fatalError || privateCustodyFailure || disposing) throw state.fatalError ?? privateCustodyFailure ?? createDisposedError();
            sdkReady = true;
        } else {
            await request('initialize', {
            clientInfo: {
                name: 'happier_cli',
                title: 'Happier',
                version: '0.1.0',
            },
            capabilities: {
                experimentalApi: true,
            },
        }, params.initializeRequestOptions);
            await notify('initialized');
        }

        return {
            request: privateOwner ? async (...args: Parameters<typeof request>) => {
                assertPrivateWorkAdmission();
                try { return await request(...args); }
                catch (error) { throw audienceFailure('request', error); }
            } : request,
            notify: privateOwner ? async (...args: Parameters<typeof notify>) => {
                try { await notify(...args); }
                catch (error) { throw audienceFailure('notification', error); }
            } : notify,
            registerRequestHandler, registerNotificationHandler, onExit, dispose,
        };
    } catch (error) {
        // Record the constructor failure before disposal performs the owner's final flush.
        const failure = privateOwner ? audienceFailure('construction', error) : error;
        await dispose().catch(() => undefined);
        throw failure;
    }
}
