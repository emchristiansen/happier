import { mkdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as childProcess from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws-node';

import { waitForCondition } from '@/testkit/async/waitFor';
import { createDeferred } from '@/testkit/async/deferred';
import { withTempDir } from '@/testkit/fs/tempDir';
import {
    HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
    HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR } from '@/daemon/spawn/spawnExplicitEnvKeysMarker';

import { createCodexAppServerClient, type CodexAppServerPrivateIoEvent, type CodexAppServerPrivateIoOwner } from './createCodexAppServerClient';
import * as codexUnixWebSocket from './createCodexUnixWebSocket';
import {
    createCodexAppServerProcessEnv,
    createCodexAppServerTestEnvScope,
    writeFakeCodexAppServerScript,
} from '../testkit/fakeCodexAppServer';

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: vi.fn(actual.spawn) };
});

function createPipedProcessBoundary(onWrite: (message: Record<string, unknown>) => void) {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new Writable({
        write(chunk: Buffer, _encoding, callback) {
            try {
                onWrite(JSON.parse(chunk.toString('utf8')) as Record<string, unknown>);
                callback();
            } catch (error) {
                callback(error instanceof Error ? error : new Error(String(error)));
            }
        },
    });
    // A fake child/pipe is the OS boundary; client framing, RPC and lifecycle stay real.
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: undefined }) as unknown as childProcess.ChildProcess;
    vi.mocked(childProcess.spawn).mockReturnValueOnce(child);
    return { child, stdin, stdout, stderr };
}

async function createPrivateProcessBoundary(owner: CodexAppServerPrivateIoOwner, onWrite?: (message: Record<string, unknown>) => void) {
    const boundary = createPipedProcessBoundary((message) => {
        if (message.method === 'initialize') {
            boundary.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\n');
        } else {
            onWrite?.(message);
        }
    });
    const client = await createCodexAppServerClient({
        processEnv: { HAPPIER_CODEX_APP_SERVER_BIN: process.execPath },
        io: { kind: 'private', owner },
    });
    const dispose = async () => {
        const disposal = client.dispose();
        boundary.child.emit('close', 0, null);
        await disposal;
    };
    return { ...boundary, client, dispose };
}

type SdkOwner = NonNullable<Extract<NonNullable<Parameters<typeof createCodexAppServerClient>[0]['io']>, { kind: 'private' }>['sdkAuth']>;
type SdkTransport = Parameters<SdkOwner['bootstrap']>[0];

async function createSdkProcessBoundary(options: Readonly<{
    sdk?: Partial<SdkOwner>;
    onWrite?: (message: Record<string, unknown>) => void;
    onCapture?: (event: CodexAppServerPrivateIoEvent) => void;
}> = {}) {
    const events: CodexAppServerPrivateIoEvent[] = [];
    const nativeWrites: Buffer[] = [];
    const order: string[] = [];
    const boundary = createPipedProcessBoundary((message) => { options.onWrite?.(message); });
    const write = boundary.stdin._write.bind(boundary.stdin);
    boundary.stdin._write = (chunk, encoding, callback) => {
        nativeWrites.push(Buffer.from(chunk)); order.push('native-write'); write(chunk, encoding, callback);
    };
    let transport: SdkTransport | undefined;
    const client = await createCodexAppServerClient({
        processEnv: { HAPPIER_CODEX_APP_SERVER_BIN: process.execPath },
        io: { kind: 'private', owner: { capture: (event) => {
            events.push(event); order.push(event.kind); options.onCapture?.(event);
        }, flush: async () => {} }, sdkAuth: {
            bootstrap: async (value) => { transport = value; await options.sdk?.bootstrap?.(value); },
            routeIncoming: options.sdk?.routeIncoming ?? (async () => 'ordinary'),
            authorizeOrdinaryWrite: options.sdk?.authorizeOrdinaryWrite ?? (async () => {}),
        } },
    });
    if (!transport) throw new Error('the actual constructor did not install its SDK transport');
    const dispose = async () => {
        const disposal = client.dispose(); boundary.child.emit('close', 0, null); await disposal;
    };
    return { ...boundary, client, transport, events, nativeWrites, order, dispose };
}

describe('createCodexAppServerClient', () => {
    it.each([
        { kind: 'daemonProxy' as const },
        { kind: 'unixWebSocket' as const, socketPath: '/unopened-private-test.sock' },
    ])('[private-io] refuses an unqualified $kind transport before opening it', async (transport) => {
        const events: CodexAppServerPrivateIoEvent[] = [];
        const flush = vi.fn(async () => {});
        // OS process/socket boundaries throw before an unsafe implementation can open either.
        const spawn = vi.mocked(childProcess.spawn);
        const originalSpawn = spawn.getMockImplementation();
        spawn.mockClear();
        spawn.mockImplementation(() => { throw new Error('Unexpected private transport process launch'); });
        const connect = vi.spyOn(codexUnixWebSocket, 'createCodexUnixWebSocket')
            .mockImplementation(() => { throw new Error('Unexpected private transport socket connection'); });
        try {
            await expect(createCodexAppServerClient({
                processEnv: { HAPPIER_CODEX_APP_SERVER_BIN: process.execPath },
                transport,
                io: { kind: 'private', owner: { capture: event => { events.push(event); }, flush } },
            })).rejects.toMatchObject({ name: 'CodexAppServerPrivateIoError' });
            expect(spawn).not.toHaveBeenCalled();
            expect(connect).not.toHaveBeenCalled();
            expect(events).toEqual([expect.objectContaining({ kind: 'failure', operation: 'construction' })]);
            expect(flush).toHaveBeenCalledOnce();
        } finally {
            connect.mockRestore();
            if (originalSpawn) spawn.mockImplementation(originalSpawn);
        }
    });

    it.skipIf(process.platform !== 'linux')('[private-sdk-descriptors] denies both held socket endpoints to the actual native child and its descendant', async () => {
        await withTempDir('happier-sdk-descriptor-custody-', async (root) => {
            const server = createServer();
            // The scratch root can exceed the Unix pathname-socket limit.
            // This unique synthetic Linux abstract address touches no path.
            const path = `\0happier-private-sdk-${randomUUID()}`;
            server.listen(path); await once(server, 'listening');
            const connected = once(server, 'connection');
            const first = connect(path); await once(first, 'connect');
            const [second] = await connected as [Socket];
            // Node does not expose its owned socket FD in the public type. This
            // OS-boundary fixture reads only these two owned descriptor links.
            const fd = (socket: Socket) => (socket as unknown as { _handle: { fd: number } })._handle.fd;
            const endpoints = [await readlink(`/proc/self/fd/${fd(first)}`), await readlink(`/proc/self/fd/${fd(second)}`)];
            let client: Awaited<ReturnType<typeof createCodexAppServerClient>> | undefined;
            try {
                // Prove the absence oracle detects an endpoint deliberately
                // inherited by this owned control child, rather than merely
                // comparing unrelated descriptor identities.
                const control = childProcess.spawnSync(process.execPath, ['-e',
                    "process.stdout.write(require('node:fs').readlinkSync('/proc/self/fd/3'))"],
                    { stdio: ['ignore', 'pipe', 'pipe', fd(first)] });
                expect(control.status).toBe(0);
                expect(control.stdout.toString('utf8')).toBe(endpoints[0]);
                const fake = await writeFakeCodexAppServerScript({ dir: root,
                    importLines: ["import fs from 'node:fs';", "import { spawnSync } from 'node:child_process';"],
                    bodyLines: [`
                        const scan = () => fs.readdirSync('/proc/self/fd').flatMap(name => {
                            try { return [fs.readlinkSync('/proc/self/fd/' + name)]; }
                            catch (error) { if (error.code === 'ENOENT') return []; throw error; }
                        });
                        for await (const line of rl) {
                            const msg = JSON.parse(line);
                            if (msg.method === 'fixture/descriptors') {
                                const inspect = "const fs=require('node:fs');process.stdout.write(JSON.stringify(fs.readdirSync('/proc/self/fd').flatMap(name=>{try{return[fs.readlinkSync('/proc/self/fd/'+name)]}catch(error){if(error.code==='ENOENT')return[];throw error}})))";
                                const child = spawnSync(process.execPath, ['-e', inspect], { stdio: ['ignore', 'pipe', 'pipe'] });
                                if (child.status !== 0) throw new Error('the synthetic descendant descriptor check failed');
                                process.stdout.write(JSON.stringify({ id: msg.id, result: { native: scan(), descendant: JSON.parse(child.stdout.toString('utf8')) } }) + '\\n');
                            }
                        }
                    `],
                });
                client = await createCodexAppServerClient({
                    processEnv: createCodexAppServerProcessEnv(fake),
                    io: { kind: 'private', owner: { capture: () => {}, flush: async () => {} }, sdkAuth: {
                        bootstrap: async () => {}, routeIncoming: async () => 'ordinary', authorizeOrdinaryWrite: async () => {},
                    } },
                });
                const result = await client.request('fixture/descriptors') as { native: string[]; descendant: string[] };
                for (const endpoint of endpoints) {
                    expect(result.native).not.toContain(endpoint);
                    expect(result.descendant).not.toContain(endpoint);
                }
                // The resource is still held by its original parent owner.
                expect(await readlink(`/proc/self/fd/${fd(first)}`)).toBe(endpoints[0]);
            } finally {
                try { if (client) await client.dispose(); }
                finally {
                    first.destroy(); second.destroy();
                    await new Promise<void>((resolve) => server.close(() => resolve()));
                }
            }
        });
    });

    it('[private-sdk] offers an overlapping raw request while the original SDK request is still owned', async () => {
        const firstEntered = createDeferred<void>();
        const finishFirst = createDeferred<'handled'>();
        const routed: Buffer[] = [];
        const boundary = await createSdkProcessBoundary({ sdk: { routeIncoming: async (line) => {
            routed.push(Buffer.from(line));
            if (routed.length === 1) { firstEntered.resolve(); return await finishFirst.promise; }
            return 'handled';
        } } });
        const first = Buffer.from('{"id":1,"method":"account/chatgptAuthTokens/refresh","params":{}}\n');
        const second = Buffer.from('{"id":2,"method":"account/chatgptAuthTokens/refresh","params":{}}\n');
        try {
            boundary.stdout.write(first); await firstEntered.promise;
            boundary.stdout.write(second);
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(routed).toEqual([first, second]);
            expect(boundary.nativeWrites).toEqual([]);
        } finally { finishFirst.resolve('handled'); await boundary.dispose(); }
    });

    it.each([
        { operation: 'initialize', frame: '{"id":1,"method":"initialize","params":{}}\n', recording: { kind: 'exact' } },
        { operation: 'initialized', frame: '{"method":"initialized"}\n', recording: { kind: 'exact' } },
        { operation: 'login', frame: '{"id":2,"method":"account/login/start","params":{"accessToken":"synthetic-login"}}\n', recording: { kind: 'login-gap', method: 'account/login/start', reconstruction: 'payload cannot be reconstructed from this record' } },
        { operation: 'refresh_result', frame: '{"id":9223372036854775807,"result":{"accessToken":"synthetic-refresh"}}\n', recording: { kind: 'refresh-result-gap', method: 'account/chatgptAuthTokens/refresh', reconstruction: 'payload cannot be reconstructed from this record' } },
        { operation: 'unavailable', frame: '{"id":-9223372036854775808,"error":{"code":-32000,"message":"unavailable"}}\n', recording: { kind: 'exact' } },
        { operation: 'refuse', frame: '{"id":"original-refresh-id","error":{"code":-32602,"message":"refused"}}\n', recording: { kind: 'exact' } },
    ] as const)('[private-sdk] keeps $operation native bytes and its one prescribed record', async ({ frame, recording }) => {
        const boundary = await createSdkProcessBoundary();
        try {
            const bytes = Buffer.from(frame);
            await boundary.transport.writeSdkFrame({ bytes, recording, signal: new AbortController().signal });
            expect(boundary.nativeWrites).toEqual([bytes]);
            const gaps = boundary.events.filter((event) => event.kind === 'auth-record-gap');
            const raw = boundary.events.filter((event) => event.kind === 'raw' && event.stream === 'stdin');
            if (recording.kind === 'exact') {
                expect(gaps).toEqual([]);
                expect(raw).toEqual([{ kind: 'raw', stream: 'stdin', bytes }]);
            } else {
                expect(gaps).toEqual([{ kind: 'auth-record-gap', stream: 'stdin', writeOrdinal: 1,
                    operation: recording.kind === 'login-gap' ? 'login' : 'refresh_result',
                    method: recording.method, reconstruction: 'payload cannot be reconstructed from this record' }]);
                expect(raw).toEqual([]);
                expect(boundary.events.filter((event) => event.kind === 'message')).toEqual([]);
                expect(boundary.order).toEqual(['auth-record-gap', 'native-write']);
            }
        } finally { await boundary.dispose(); }
    });

    it.each([
        '{"id":9223372036854775807,"method":"account/chatgptAuthTokens/refresh","params":{"reason":"unauthorized"}}\n',
        '{"id":-9223372036854775808,"method":"account/chatgptAuthTokens/refresh","params":{"reason":"unauthorized"}}\n',
        '{"id":"original-α-id","method":"account/chatgptAuthTokens/refresh","params":{"reason":"unauthorized"}}\n',
    ])('[private-sdk] offers the complete original directional ID line before generic handling: %s', async (frame) => {
        const received = createDeferred<Uint8Array>();
        const boundary = await createSdkProcessBoundary({ sdk: { routeIncoming: async (line) => {
            received.resolve(line); return 'handled';
        } } });
        try {
            const bytes = Buffer.from(frame); const cut = bytes.length - 3;
            boundary.stdout.write(bytes.subarray(0, cut)); boundary.stdout.write(bytes.subarray(cut));
            expect(Buffer.from(await received.promise)).toEqual(bytes);
            expect(boundary.nativeWrites).toEqual([]);
            expect(boundary.events.filter((event) => event.kind === 'message' || event.kind === 'frame')).toEqual([]);
        } finally { await boundary.dispose(); }
    });

    it('[private-sdk] releases a write only after the original stdin callback', async () => {
        const boundary = await createSdkProcessBoundary();
        const started = createDeferred<() => void>();
        boundary.stdin._write = (_bytes, _encoding, callback) => { started.resolve(() => callback()); };
        let completed = false;
        const write = boundary.transport.writeSdkFrame({ bytes: Buffer.from('{"method":"initialized"}\n'), recording: { kind: 'exact' }, signal: new AbortController().signal })
            .then(() => { completed = true; });
        const completeWrite = await started.promise;
        try {
            expect(completed).toBe(false);
            completeWrite(); await write; expect(completed).toBe(true);
        } finally { await boundary.dispose(); }
    });

    it.each(['abort', 'close', 'failure'] as const)('[private-sdk] rejects %s before a pending write callback and retains the later failure separately', async (failure) => {
        const boundary = await createSdkProcessBoundary();
        const started = createDeferred<(error?: Error) => void>();
        boundary.stdin._write = (_bytes, _encoding, callback) => { started.resolve(callback); };
        const abort = new AbortController();
        const bytes = Buffer.from('{"id":1,"method":"account/login/start","params":{"accessToken":"synthetic-login"}}\n');
        const write = boundary.transport.writeSdkFrame({ bytes, recording: { kind: 'login-gap', method: 'account/login/start', reconstruction: 'payload cannot be reconstructed from this record' }, signal: abort.signal })
            .then(() => 'incorrect-success', (error: unknown) => error);
        const completeWrite = await started.promise;
        try {
            if (failure === 'abort') abort.abort();
            if (failure === 'close') boundary.child.emit('close', 0, null);
            if (failure === 'failure') boundary.stdin.emit('error', new Error('synthetic write failure'));
            expect(await write).toBeInstanceOf(Error);
            completeWrite();
            expect(boundary.events.filter((event) => event.kind === 'auth-record-gap')).toHaveLength(1);
            expect(boundary.events.some((event) => event.kind === 'failure')).toBe(true);
            expect(boundary.events.filter((event) => event.kind === 'raw' && event.stream === 'stdin')).toEqual([]);
            await expect(boundary.client.notify('later/notification')).rejects.toBeInstanceOf(Error);
        } finally { await boundary.dispose(); }
    });

    it('[private-sdk] stops before native writing if selected-gap custody fails', async () => {
        const boundary = await createSdkProcessBoundary({ onCapture: (event) => {
            if (event.kind === 'auth-record-gap') throw new Error('synthetic recorder failure');
        } });
        try {
            await expect(boundary.transport.writeSdkFrame({ bytes: Buffer.from('{"id":1,"result":{}}\n'), recording: { kind: 'refresh-result-gap', method: 'account/chatgptAuthTokens/refresh', reconstruction: 'payload cannot be reconstructed from this record' }, signal: new AbortController().signal })).rejects.toBeInstanceOf(Error);
            expect(boundary.nativeWrites).toEqual([]);
            await expect(boundary.client.notify('later/notification')).rejects.toBeInstanceOf(Error);
        } finally { await expect(boundary.dispose()).rejects.toBeInstanceOf(Error); }
    });

    it('[private-sdk] authorizes requests, notifications and each bound handler reply before capture', async () => {
        const checked: unknown[] = [];
        let answer: ((message: Record<string, unknown>) => void) | undefined;
        const responses: Record<string, unknown>[] = [];
        const boundary = await createSdkProcessBoundary({ sdk: { authorizeOrdinaryWrite: async (input) => { checked.push(input); } }, onWrite: (message) => {
            if (message.method === 'ordinary/request') answer?.(message);
            if (message.id === 'success' || message.id === 'failure' || message.id === 'missing') responses.push(message);
        } });
        answer = (message) => { boundary.stdout.write(JSON.stringify({ id: message.id, result: 'ordinary-result' }) + '\n'); };
        try {
            expect(await boundary.client.request('ordinary/request')).toBe('ordinary-result');
            await boundary.client.notify('ordinary/notify');
            boundary.client.registerRequestHandler('ordinary/success', () => 'accepted');
            boundary.client.registerRequestHandler('ordinary/failure', () => { throw new Error('synthetic handler failure'); });
            for (const [id, method] of [['success', 'ordinary/success'], ['failure', 'ordinary/failure'], ['missing', 'ordinary/missing']]) {
                boundary.stdout.write(JSON.stringify({ id, method, params: {} }) + '\n');
            }
            await waitForCondition(() => responses.length === 3, { timeoutMs: 5_000, label: 'the three authorized handler replies' });
            expect(checked).toHaveLength(5);
            expect(checked).toEqual(expect.arrayContaining([
                { kind: 'request', method: 'ordinary/request' }, { kind: 'notification', method: 'ordinary/notify' },
                { kind: 'reply', method: 'ordinary/success' }, { kind: 'reply', method: 'ordinary/failure' }, { kind: 'reply', method: 'ordinary/missing' },
            ]));
        } finally { await boundary.dispose(); }
    });

    it('[private-sdk] refuses an unauthorized ordinary method before it reaches any output capture', async () => {
        const boundary = await createSdkProcessBoundary({ sdk: { authorizeOrdinaryWrite: async () => { throw new Error('synthetic SDK and Wire refusal'); } } });
        try {
            await expect(boundary.client.request('account/login/start', { synthetic: 'ordinary-bypass' })).rejects.toBeInstanceOf(Error);
            expect(boundary.nativeWrites).toEqual([]);
            expect(boundary.events.some((event) => event.kind === 'message' && event.direction === 'outgoing')).toBe(false);
        } finally { await boundary.dispose(); }
    });

    it('[private-sdk] replaces only the private initialization with the retained SDK bootstrap', async () => {
        const writes: Record<string, unknown>[] = [];
        const events: CodexAppServerPrivateIoEvent[] = [];
        const boundary = createPipedProcessBoundary((message) => {
            writes.push(message);
            if (message.method === 'initialize') boundary.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\n');
        });
        const bootstrap = vi.fn(async (transport: Readonly<{
            reserveClientRequestId: () => number;
            writeSdkFrame: (input: Readonly<{ bytes: Uint8Array; recording: Readonly<{ kind: 'exact' }>; signal: AbortSignal }>) => Promise<void>;
        }>) => {
            const id = transport.reserveClientRequestId();
            await transport.writeSdkFrame({
                bytes: Buffer.from(`{"id":${id},"method":"initialize","params":{"clientInfo":{"name":"codex-tui","title":null,"version":"0.162.1"},"capabilities":{"explicitGatewayOauth":true,"experimentalApi":true,"requestAttestation":false,"optOutNotificationMethods":null}}}\n`),
                recording: { kind: 'exact' }, signal: new AbortController().signal,
            });
            await transport.writeSdkFrame({ bytes: Buffer.from('{"method":"initialized"}\n'), recording: { kind: 'exact' }, signal: new AbortController().signal });
        });
        const parameters = {
            processEnv: { HAPPIER_CODEX_APP_SERVER_BIN: process.execPath },
            io: { kind: 'private' as const, owner: { capture: (event: CodexAppServerPrivateIoEvent) => { events.push(event); }, flush: async () => {} },
                sdkAuth: { bootstrap, routeIncoming: async (_line: Uint8Array) => 'handled' as const, authorizeOrdinaryWrite: async () => {} } },
        };
        const client = await createCodexAppServerClient(parameters);
        try {
            expect(bootstrap).toHaveBeenCalledTimes(1);
            expect(writes).toHaveLength(2);
            expect(writes[0]).toMatchObject({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-tui', version: '0.162.1' } } });
            expect(writes[1]).toEqual({ method: 'initialized' });
        } finally {
            const disposal = client.dispose(); boundary.child.emit('close', 0, null); await disposal;
        }
    });

    it('[private-sdk] preserves the complete default initialization fixture bytes without a bootstrap', async () => {
        const events: CodexAppServerPrivateIoEvent[] = [];
        const boundary = await createPrivateProcessBoundary({ capture: (event) => { events.push(event); }, flush: async () => {} });
        try {
            const raw = events.filter((event) => event.kind === 'raw' && event.stream === 'stdin')
                .map((event) => event.kind === 'raw' ? Buffer.from(event.bytes) : Buffer.alloc(0));
            expect(raw).toEqual([
                Buffer.from('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"happier_cli","title":"Happier","version":"0.1.0"},"capabilities":{"experimentalApi":true}}}\n'),
                Buffer.from('{"method":"initialized","params":{}}\n'),
            ]);
        } finally { await boundary.dispose(); }
    });

    it('[private-io] owns the first raw and parsed frame before initialization completes without ordinary RPC logging', async () => {
        await withTempDir('happier-private-native-io-first-frame-', async (root) => {
            const events: unknown[] = [];
            const flush = vi.fn(async () => {});
            let initializeId: unknown;
            let initialized = false;
            let observeInitialize: () => void = () => {};
            const initializeObserved = new Promise<void>((resolve) => { observeInitialize = resolve; });
            const processBoundary = createPipedProcessBoundary((message) => {
                if (message.method === 'initialize') { initializeId = message.id; observeInitialize(); }
            });
            const ordinaryLog = join(root, 'ordinary-rpc.jsonl');
            const construction = {
                processEnv: { HAPPIER_CODEX_APP_SERVER_BIN: process.execPath, HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH: ordinaryLog },
                io: { kind: 'private' as const, owner: { capture: (event: unknown) => { events.push(event); }, flush } },
            };
            const creation = createCodexAppServerClient(construction).then((client) => { initialized = true; return client; });
            await initializeObserved;
            const firstMessage = { method: 'item/started', params: { privateText: 'first-native-record' } };
            const firstBytes = Buffer.from(JSON.stringify(firstMessage) + '\n');
            const firstData = new Promise<void>((resolve) => processBoundary.stdout.once('data', () => resolve()));
            processBoundary.stdout.write(firstBytes);
            await firstData;
            try {
                expect(initialized).toBe(false);
                expect(events).toContainEqual({ kind: 'raw', stream: 'stdout', bytes: firstBytes });
                expect(events).toContainEqual({ kind: 'message', direction: 'incoming', message: firstMessage });
            } finally {
                processBoundary.stdout.write(JSON.stringify({ id: initializeId, result: {} }) + '\n');
                const client = await creation;
                const disposal = client.dispose();
                processBoundary.child.emit('close', 0, null);
                await disposal;
            }
            expect(flush).toHaveBeenCalledTimes(1);
            await expect(readFile(ordinaryLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        });
    });

    it('[private-io] retains exact split UTF-8 bytes, complete stderr, and both directions of RPC traffic', async () => {
        const events: CodexAppServerPrivateIoEvent[] = [];
        let observeResponse: (message: Record<string, unknown>) => void = () => {};
        const response = new Promise<Record<string, unknown>>((resolve) => { observeResponse = resolve; });
        const boundary = await createPrivateProcessBoundary({ capture: (event) => { events.push(event); }, flush: async () => {} }, (message) => {
            if (message.method === 'private/request') {
                boundary.stdout.write(JSON.stringify({ id: message.id, result: { exact: 'private-result' } }) + '\n');
            }
            if (message.id === 'native-request') observeResponse(message);
        });
        try {
            boundary.client.registerRequestHandler('native/request', (params) => ({ retained: params }));
            const notification = { method: 'native/notification', params: { text: 'α🐈' } };
            const bytes = Buffer.from(JSON.stringify(notification) + '\n');
            const split = bytes.indexOf(Buffer.from('🐈')) + 2;
            boundary.stdout.write(bytes.subarray(0, split));
            boundary.stdout.write(bytes.subarray(split));
            const stderr = Buffer.concat([Buffer.alloc(9_000, 120), Buffer.from([0xff, 0, 0xfe])]);
            boundary.stderr.write(stderr);
            const nativeRequest = { id: 'native-request', method: 'native/request', params: { opaque: 'unmodified' } };
            boundary.stdout.write(JSON.stringify(nativeRequest) + '\n');
            expect(await response).toEqual({ id: 'native-request', result: { retained: nativeRequest.params } });
            await boundary.client.notify('private/notification', { exact: 'outgoing' });
            expect(await boundary.client.request('private/request', { exact: 'request' })).toEqual({ exact: 'private-result' });
            expect(events).toContainEqual({ kind: 'raw', stream: 'stdout', bytes: bytes.subarray(0, split) });
            expect(events).toContainEqual({ kind: 'raw', stream: 'stdout', bytes: bytes.subarray(split) });
            expect(events).toContainEqual({ kind: 'raw', stream: 'stderr', bytes: stderr });
            for (const message of [notification, nativeRequest]) {
                expect(events).toContainEqual({ kind: 'frame', text: JSON.stringify(message) });
                expect(events).toContainEqual({ kind: 'message', direction: 'incoming', message });
            }
            const written = Buffer.concat(events.filter((event) => event.kind === 'raw' && event.stream === 'stdin').map((event) => event.kind === 'raw' ? Buffer.from(event.bytes) : Buffer.alloc(0))).toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
            expect(written).toContainEqual({ method: 'private/notification', params: { exact: 'outgoing' } });
            for (const message of written) expect(events).toContainEqual({ kind: 'message', direction: 'outgoing', message });
            expect(events.some((event) => event.kind === 'message' && event.direction === 'incoming' && (event.message as { result?: unknown }).result !== undefined)).toBe(true);
        } finally { await boundary.dispose(); }
    });

    it('[private-io] keeps native RPC error details in custody and returns a value-free failure', async () => {
        const events: CodexAppServerPrivateIoEvent[] = [];
        const nativeError = { code: -32000, message: 'private RPC failure text', data: { retained: 'native-error-data' } };
        const boundary = await createPrivateProcessBoundary({ capture: (event) => { events.push(event); }, flush: async () => {} }, (message) => {
            if (message.method === 'private/failure') boundary.stdout.write(JSON.stringify({ id: message.id, error: nativeError }) + '\n');
        });
        try {
            await expect(boundary.client.request('private/failure')).rejects.toThrow('Private Codex app-server request failed; diagnostic values are not shown');
            expect(events.some((event) => event.kind === 'message' && event.direction === 'incoming' && JSON.stringify(event.message).includes(JSON.stringify(nativeError)))).toBe(true);
            expect(events.some((event) => event.kind === 'failure' && event.operation === 'request' && event.error instanceof Error && event.error.message.includes(nativeError.message))).toBe(true);
        } finally { await boundary.dispose(); }
    });

    it.each(['malformed', 'stdout', 'stderr', 'stdin', 'launch', 'close'] as const)('[private-io] retains %s failure and keeps observers and pending requests free of its values', async (failureKind) => {
        const events: CodexAppServerPrivateIoEvent[] = [];
        const boundary = await createPrivateProcessBoundary({ capture: (event) => { events.push(event); }, flush: async () => {} });
        const observed: Error[] = [];
        boundary.client.onExit((error) => { observed.push(error); });
        const pending = boundary.client.request('private/pending', {}, { timeoutMs: null }).catch((error: unknown) => error);
        const original = new Error('private stream failure value');
        const malformed = Buffer.from('private malformed frame\n');
        try {
            if (failureKind === 'malformed') boundary.stdout.write(malformed);
            else if (failureKind === 'close') { boundary.stderr.write('private exit stderr'); boundary.child.emit('close', 37, 'SIGTERM'); }
            else if (failureKind === 'launch') boundary.child.emit('error', original);
            else boundary[failureKind].emit('error', original);
            const failure = await pending;
            expect(failure).toBeInstanceOf(Error);
            expect((failure as Error).message).toContain('diagnostic values are not shown');
            expect((failure as Error).message).not.toContain('private stream failure value');
            expect((failure as Error).message).not.toContain('private exit stderr');
            expect(observed).toEqual([failure]);
            if (failureKind === 'malformed') {
                expect(events).toContainEqual({ kind: 'raw', stream: 'stdout', bytes: malformed });
                expect(events).toContainEqual({ kind: 'frame', text: 'private malformed frame' });
                expect(events.some((event) => event.kind === 'failure' && event.operation === 'frame parsing' && event.error instanceof SyntaxError)).toBe(true);
            } else if (failureKind === 'close') {
                expect(events).toContainEqual({ kind: 'close', code: 37, signal: 'SIGTERM' });
            } else expect(events).toContainEqual({ kind: 'failure', operation: failureKind, error: original });
        } finally { await boundary.dispose(); }
    });

    it('[private-io] refuses after capture failure, and preserves owner flush failures in custody', async () => {
        const events: CodexAppServerPrivateIoEvent[] = [];
        const captureError = new Error('private capture failure');
        const flushError = new Error('private flush failure');
        const boundary = await createPrivateProcessBoundary({
            capture: (event) => {
                if (event.kind === 'raw' && event.stream === 'stderr') throw captureError;
                events.push(event);
            },
            flush: async () => { throw flushError; },
        });
        boundary.stderr.write('private stderr');
        await expect(boundary.client.notify('must/not/write')).rejects.toThrow('diagnostic values are not shown');
        await expect(boundary.dispose()).rejects.toThrow('Private Codex app-server disposal flush failed; diagnostic values are not shown');
        expect(events).toContainEqual({ kind: 'failure', operation: 'capture', error: captureError });
        expect(events).toContainEqual({ kind: 'failure', operation: 'disposal flush', error: flushError });
        expect(events.some((event) => event.kind === 'message' && event.direction === 'outgoing' && (event.message as { method?: string }).method === 'must/not/write')).toBe(false);
    });

    it.each(['outgoing', 'failure-record', 'queued-write'] as const)('[private-io-terminal] forbids later native writes after one %s custody failure even when the owner recovers', async (failurePoint) => {
        const events: CodexAppServerPrivateIoEvent[] = [];
        const writes: Record<string, unknown>[] = [];
        const captureFailure = new Error('private one-shot custody failure');
        let failed = false;
        const boundary = await createPrivateProcessBoundary({
            capture: (event) => {
                events.push(event);
                if (failed) return;
                const failOutgoing = event.kind === 'message' && event.direction === 'outgoing' && (event.message as { method?: string }).method === 'fail/custody';
                const failFailureRecord = event.kind === 'failure' && event.operation === 'request';
                if ((failurePoint === 'failure-record' && failFailureRecord) || (failurePoint !== 'failure-record' && failOutgoing)) {
                    failed = true;
                    throw captureFailure;
                }
            },
            flush: async () => {},
        }, (message) => {
            writes.push(message);
            if (message.method === 'private/rpc-error') boundary.stdout.write(JSON.stringify({ id: message.id, error: { code: -32000, message: 'private native refusal' } }) + '\n');
        });
        try {
            const queued = failurePoint === 'queued-write'
                ? boundary.client.notify('queued/before-custody').then(() => null, (error: unknown) => error)
                : null;
            if (failurePoint === 'failure-record') await expect(boundary.client.request('private/rpc-error')).rejects.toThrow('failure custody');
            else await expect(boundary.client.notify('fail/custody')).rejects.toThrow('diagnostic values are not shown');
            expect(failed).toBe(true);
            await expect(boundary.client.notify('later/notification')).rejects.toThrow('diagnostic values are not shown');
            await expect(boundary.client.request('later/request')).rejects.toThrow('diagnostic values are not shown');
            if (queued) expect(await queued).toBeInstanceOf(Error);
            expect(writes.filter((message) => message.method !== 'initialized' && message.method !== 'private/rpc-error')).toEqual([]);
            await expect(boundary.dispose()).rejects.toThrow('diagnostic values are not shown');
        } finally {
            await boundary.dispose().catch(() => undefined);
        }
    });

    it('[private-io-reentry] refuses the outer write when raw capture reenters a failing notification', async () => {
        const writes: Record<string, unknown>[] = [];
        const events: CodexAppServerPrivateIoEvent[] = [];
        const captureError = new Error('private nested capture failure');
        let nested: Promise<unknown> | null = null;
        const boundary = await createPrivateProcessBoundary({
            capture: (event) => {
                events.push(event);
                if (event.kind === 'message' && event.direction === 'outgoing' && (event.message as { method?: string }).method === 'nested/custody') {
                    throw captureError;
                }
                if (event.kind === 'raw' && event.stream === 'stdin' && JSON.parse(Buffer.from(event.bytes).toString('utf8')).method === 'outer/notification') {
                    // The outer capture returns normally after this synchronous nested capture fails.
                    nested = boundary.client.notify('nested/custody').then(() => null, (error: unknown) => error);
                }
            },
            flush: async () => {},
        }, (message) => { writes.push(message); });
        try {
            const outer = await boundary.client.notify('outer/notification').then(() => null, (error: unknown) => error);
            expect(nested).not.toBeNull();
            expect(await nested).toBeInstanceOf(Error);
            expect(outer).toBeInstanceOf(Error);
            await expect(boundary.client.notify('future/notification')).rejects.toThrow('diagnostic values are not shown');
            await expect(boundary.client.request('future/request')).rejects.toThrow('diagnostic values are not shown');
            expect(writes.filter((message) => message.method !== 'initialized')).toEqual([]);
            expect(events).toContainEqual({ kind: 'failure', operation: 'capture', error: captureError });
            await expect(boundary.dispose()).rejects.toThrow('diagnostic values are not shown');
        } finally {
            await boundary.dispose().catch(() => undefined);
        }
    });

    it.each(['notification', 'request', 'exit'] as const)('[private-io-async] drains a deferred %s failure before disposal flush', async (kind) => {
        const pending: CodexAppServerPrivateIoEvent[] = [];
        const drained: CodexAppServerPrivateIoEvent[] = [];
        const failure = new Error('private deferred callback failure');
        const gate = createDeferred();
        const started = createDeferred();
        const capturedFailure = createDeferred();
        const flush = vi.fn(async () => { drained.push(...pending.splice(0)); });
        const boundary = await createPrivateProcessBoundary({
            capture: (event) => {
                pending.push(event);
                if (event.kind === 'failure' && event.error === failure) capturedFailure.resolve();
            },
            flush,
        });
        const handler = () => { started.resolve(); return gate.promise; };
        if (kind === 'notification') boundary.client.registerNotificationHandler('native/deferred', handler);
        else if (kind === 'request') boundary.client.registerRequestHandler('native/deferred', handler);
        else boundary.client.onExit(handler);
        if (kind === 'exit') boundary.child.emit('error', new Error('private process failure'));
        else boundary.stdout.write(JSON.stringify({ ...(kind === 'request' ? { id: 'deferred-request' } : {}), method: 'native/deferred' }) + '\n');
        await started.promise;
        let disposed = false;
        const disposal = boundary.dispose().then(() => { disposed = true; });
        try {
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(disposed).toBe(false);
            expect(flush).not.toHaveBeenCalled();
            gate.reject(failure);
            await capturedFailure.promise;
            await disposal;
            expect(flush).toHaveBeenCalledTimes(1);
            expect(pending).toEqual([]);
            expect(drained).toContainEqual(expect.objectContaining({ kind: 'failure', error: failure }));
            expect(drained).toContainEqual({ kind: 'close', code: 0, signal: null });
        } finally {
            gate.reject(failure);
            await capturedFailure.promise;
            await disposal;
        }
    });

    it.each(['before-await', 'after-await'] as const)('[private-io-async] refuses %s reentrant disposal before returning an existing disposal promise', async (phase) => {
        const events: CodexAppServerPrivateIoEvent[] = [];
        const gate = createDeferred();
        const started = createDeferred();
        const reentrant = createDeferred<unknown>();
        const flush = vi.fn(async () => {});
        const boundary = await createPrivateProcessBoundary({ capture: (event) => { events.push(event); }, flush });
        boundary.client.registerNotificationHandler('native/reentrant-disposal', async () => {
            started.resolve();
            if (phase === 'after-await') await gate.promise;
            const result = await boundary.client.dispose().then(() => null, (error: unknown) => error);
            reentrant.resolve(result);
        });
        boundary.stdout.write(JSON.stringify({ method: 'native/reentrant-disposal' }) + '\n');
        await started.promise;
        const disposal = boundary.dispose();
        gate.resolve();
        const result = await reentrant.promise;
        await disposal;
        expect(result).toBeInstanceOf(Error);
        expect(events).toContainEqual(expect.objectContaining({ kind: 'failure', operation: 'reentrant disposal' }));
        expect(flush).toHaveBeenCalledTimes(1);
    });

    it('[private-io-async] allows another client and settled callback descendants to dispose', async () => {
        const events: CodexAppServerPrivateIoEvent[] = [];
        const firstFlush = vi.fn(async () => {});
        const secondFlush = vi.fn(async () => {});
        const first = await createPrivateProcessBoundary({ capture: (event) => { events.push(event); }, flush: firstFlush });
        const second = await createPrivateProcessBoundary({ capture: () => {}, flush: secondFlush });
        const gate = createDeferred();
        const callbackFinished = createDeferred();
        let descendant: Promise<void> | null = null;
        first.client.registerNotificationHandler('native/other-client', async () => {
            await Promise.resolve();
            await second.dispose();
            descendant = gate.promise.then(() => first.dispose());
            callbackFinished.resolve();
        });
        first.stdout.write(JSON.stringify({ method: 'native/other-client' }) + '\n');
        await callbackFinished.promise;
        // The callback has settled before its independently gated descendant runs.
        await new Promise<void>((resolve) => setImmediate(resolve));
        gate.resolve();
        expect(descendant).not.toBeNull();
        await expect(descendant).resolves.toBeUndefined();
        expect(firstFlush).toHaveBeenCalledTimes(1);
        expect(secondFlush).toHaveBeenCalledTimes(1);
        expect(events.some((event) => event.kind === 'failure' && event.operation === 'reentrant disposal')).toBe(false);
    });

    it('[private-io-async] closes callback registration and native dispatch before final disposal flush', async () => {
        const events: CodexAppServerPrivateIoEvent[] = [];
        const pending: CodexAppServerPrivateIoEvent[] = [];
        const boundary = await createPrivateProcessBoundary({
            capture: (event) => { events.push(event); pending.push(event); },
            flush: async () => { pending.splice(0); },
        });
        const invoked = vi.fn();
        boundary.client.registerRequestHandler('native/after-shutdown', invoked);
        boundary.client.registerNotificationHandler('native/after-shutdown', invoked);
        boundary.child.emit('error', new Error('private original process failure'));
        const disposal = boundary.client.dispose();
        boundary.stdout.write(JSON.stringify({ method: 'native/after-shutdown' }) + '\n');
        boundary.stdout.write(JSON.stringify({ id: 'after-shutdown', method: 'native/after-shutdown' }) + '\n');
        boundary.child.emit('close', 0, null);
        await disposal;
        const finalCount = events.length;
        // reportedExitFailure is already set; late registration must not invoke its replay branch.
        const refusals = [
            () => boundary.client.registerRequestHandler('late/request', invoked),
            () => boundary.client.registerNotificationHandler('late/notification', invoked),
            () => boundary.client.onExit(invoked),
        ].map((register) => {
            try { register(); return null; }
            catch (error) { return error; }
        });
        expect(refusals.every((error) => error instanceof Error)).toBe(true);
        expect(invoked).not.toHaveBeenCalled();
        await expect(boundary.client.request('late/already-aborted', undefined, { signal: AbortSignal.abort() })).rejects.toThrow('diagnostic values are not shown');
        expect(events).toHaveLength(finalCount);
        expect(pending).toEqual([]);
    });

    it('[private-io-async] settles an existing pipe write and refuses queued writes before final flush', async () => {
        const pending: CodexAppServerPrivateIoEvent[] = [];
        const flush = vi.fn(async () => { pending.splice(0); });
        const boundary = await createPrivateProcessBoundary({ capture: (event) => { pending.push(event); }, flush });
        const firstWrite = createDeferred();
        const nativeMethods: string[] = [];
        let finishWrite: (() => void) | null = null;
        const write = vi.spyOn(boundary.stdin, 'write').mockImplementation((chunk, _encoding, callback) => {
            const method = (JSON.parse(String(chunk)) as { method: string }).method;
            nativeMethods.push(method);
            if (method === 'first/pending') {
                finishWrite = () => { if (typeof callback === 'function') callback(undefined); };
                firstWrite.resolve();
            } else if (typeof callback === 'function') callback(undefined);
            return true;
        });
        const first = boundary.client.notify('first/pending');
        const queued = boundary.client.notify('second/queued').then(() => null, (error: unknown) => error);
        await firstWrite.promise;
        const disposal = boundary.dispose();
        try {
            await new Promise<void>((resolve) => setImmediate(resolve));
            const flushesBeforeWriteSettled = flush.mock.calls.length;
            if (!finishWrite) throw new Error('Expected pending native pipe callback');
            (finishWrite as () => void)();
            await first;
            const queuedResult = await queued;
            await disposal;
            expect({ flushesBeforeWriteSettled, queuedRefused: queuedResult instanceof Error, nativeMethods, pending, finalFlushes: flush.mock.calls.length }).toEqual({
                flushesBeforeWriteSettled: 0, queuedRefused: true, nativeMethods: ['first/pending'], pending: [], finalFlushes: 1,
            });
        } finally {
            if (finishWrite) (finishWrite as () => void)();
            await first;
            await queued;
            await disposal;
            write.mockRestore();
        }
    });

    it('[private-io-shutdown-reentry] refuses a native write when raw capture initiates disposal', async () => {
        const pending: CodexAppServerPrivateIoEvent[] = [];
        const writes: Record<string, unknown>[] = [];
        const flush = vi.fn(async () => { pending.splice(0); });
        let disposal: Promise<void> | null = null;
        const boundary = await createPrivateProcessBoundary({
            capture: (event) => {
                pending.push(event);
                if (event.kind === 'raw' && event.stream === 'stdin' && JSON.parse(Buffer.from(event.bytes).toString('utf8')).method === 'dispose/during-capture') {
                    disposal = boundary.client.dispose();
                    boundary.child.emit('close', 0, null);
                }
            },
            flush,
        }, (message) => { writes.push(message); });
        const result = await boundary.client.notify('dispose/during-capture').then(() => null, (error: unknown) => error);
        expect(disposal).not.toBeNull();
        await disposal;
        expect({ refused: result instanceof Error, writes: writes.filter((message) => message.method !== 'initialized'), pending, flushes: flush.mock.calls.length }).toEqual({
            refused: true, writes: [], pending: [], flushes: 1,
        });
    });

    it('[private-io-disposal-latch] memoizes disposal before a synchronous owner reenters its failure capture', async () => {
        const pending: CodexAppServerPrivateIoEvent[] = [];
        const captured: CodexAppServerPrivateIoEvent[] = [];
        const flush = vi.fn(async () => { pending.splice(0); });
        let reentered = false;
        let nested: Promise<void> | null = null;
        const boundary = await createPrivateProcessBoundary({
            capture: (event) => {
                captured.push(event);
                pending.push(event);
                if (event.kind === 'failure' && event.operation === 'disposal' && !reentered) {
                    // Bound the counterexample to one nested call; never recurse toward a host limit.
                    reentered = true;
                    nested = boundary.client.dispose();
                }
            },
            flush,
        });
        const disposal = boundary.dispose();
        await disposal;
        expect(nested).not.toBeNull();
        await nested;
        expect(captured.filter((event) => event.kind === 'failure' && event.operation === 'disposal')).toHaveLength(1);
        expect(flush).toHaveBeenCalledTimes(1);
        expect(pending).toEqual([]);
    });

    it('preserves ordinary callback disposal control semantics', async () => {
        const boundary = createPipedProcessBoundary((message) => {
            if (message.method === 'initialize') boundary.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\n');
        });
        const client = await createCodexAppServerClient({ processEnv: { HAPPIER_CODEX_APP_SERVER_BIN: process.execPath } });
        const finished = createDeferred();
        client.registerNotificationHandler('ordinary/disposal', async () => {
            await Promise.resolve();
            await client.dispose();
            finished.resolve();
        });
        boundary.stdout.write(JSON.stringify({ method: 'ordinary/disposal' }) + '\n');
        boundary.child.emit('close', 0, null);
        await finished.promise;
        await expect(client.dispose()).resolves.toBeUndefined();
    });

    it('[private-io] captures construction failure before an ordinary logger can be created', async () => {
        await withTempDir('happier-private-construction-failure-', async (root) => {
            const events: CodexAppServerPrivateIoEvent[] = [];
            const original = new Error('private spawn failure');
            const flush = vi.fn(async () => {});
            vi.mocked(childProcess.spawn).mockImplementationOnce(() => { throw original; });
            const ordinaryLog = join(root, 'ordinary-rpc.jsonl');
            await expect(createCodexAppServerClient({
                processEnv: { HAPPIER_CODEX_APP_SERVER_BIN: process.execPath, HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH: ordinaryLog },
                io: { kind: 'private', owner: { capture: (event) => { events.push(event); }, flush } },
            })).rejects.toThrow('Private Codex app-server construction failed; diagnostic values are not shown');
            expect(events).toContainEqual({ kind: 'failure', operation: 'construction', error: original });
            expect(flush).toHaveBeenCalledTimes(1);
            await expect(readFile(ordinaryLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        });
    });

    it('[private-io-drain] retains initialization and cleanup failures before the final constructor flush', async () => {
        const events: CodexAppServerPrivateIoEvent[] = [];
        const pending: CodexAppServerPrivateIoEvent[] = [];
        const drained: CodexAppServerPrivateIoEvent[] = [];
        const afterFlush: CodexAppServerPrivateIoEvent[] = [];
        let flushed = false;
        const flush = vi.fn(async () => {
            drained.push(...pending.splice(0));
            flushed = true;
        });
        const nativeError = { code: -32001, message: 'private initialize failure', data: { retained: 'complete' } };
        const boundary = createPipedProcessBoundary((message) => {
            if (message.method !== 'initialize') return;
            boundary.stdout.write(JSON.stringify({ id: message.id, error: nativeError }) + '\n');
        });
        await expect(createCodexAppServerClient({
            processEnv: { HAPPIER_CODEX_APP_SERVER_BIN: process.execPath },
            io: { kind: 'private', owner: {
                capture: (event) => {
                    events.push(event);
                    pending.push(event);
                    if (flushed) afterFlush.push(event);
                    if (event.kind === 'failure' && event.operation === 'disposal') {
                        queueMicrotask(() => { boundary.child.emit('close', 1, null); });
                    }
                },
                flush,
            } },
        })).rejects.toThrow('Private Codex app-server construction failed; diagnostic values are not shown');
        expect(events.some((event) => event.kind === 'message' && event.direction === 'incoming' && JSON.stringify(event.message).includes(JSON.stringify(nativeError)))).toBe(true);
        expect(events.some((event) => event.kind === 'failure' && event.operation === 'construction' && event.error instanceof Error && event.error.message.includes(nativeError.message))).toBe(true);
        expect(flush).toHaveBeenCalledTimes(1);
        expect(afterFlush).toEqual([]);
        expect(pending).toEqual([]);
        expect(drained).toEqual(events);
        expect(drained.filter((event) => event.kind === 'failure').map((event) => event.kind === 'failure' ? event.operation : null)).toEqual(['construction', 'disposal']);
        expect(drained.at(-1)).toEqual({ kind: 'close', code: 1, signal: null });
    });

    it('serializes native initialization for shared SQLite state without serializing ongoing clients', async () => {
        await withTempDir('happier-codex-app-server-native-startup-', async (root) => {
            await mkdir(join(root, 'sqlite'), { recursive: true });
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                importLines: ['import { mkdir, rm } from "node:fs/promises";', 'import { join } from "node:path";'],
                setupLines: [
                    'const nativeStartup = join(process.env.CODEX_SQLITE_HOME, "native-startup");',
                ],
                bodyLines: [
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    try { await mkdir(nativeStartup); } catch (error) {',
                    '      process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: error.code } }) + "\\n");',
                    '      continue;',
                    '    }',
                    '    await new Promise(resolve => setTimeout(resolve, 100));',
                    '    await rm(nativeStartup, { recursive: true });',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n");',
                    '  } else if (msg.method === "test/ping") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { pong: true } }) + "\\n");',
                    '  }',
                    '}',
                ],
            });
            const clients: Awaited<ReturnType<typeof createCodexAppServerClient>>[] = [];
            const spawn = vi.mocked(childProcess.spawn);
            const originalSpawn = spawn.getMockImplementation();
            if (!originalSpawn) throw new Error('Expected the OS spawn observer');
            const stderr: string[] = [];
            spawn.mockImplementation((...args) => {
                const child = originalSpawn(...args);
                child.stderr?.on('data', chunk => { stderr.push(String(chunk)); });
                return child;
            });
            try {
                const outcomes = await Promise.allSettled(['account-a', 'account-b'].map(async (home) => {
                    const client = await createCodexAppServerClient({
                        initializeRequestOptions: { timeoutMs: 2_000 },
                        processEnv: createCodexAppServerProcessEnv(fakeAppServer, {
                            CODEX_HOME: join(root, home), CODEX_SQLITE_HOME: join(root, 'sqlite'),
                        }),
                    });
                    clients.push(client);
                    return client;
                }));
                expect({ failures: outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : []), stderr })
                    .toEqual({ failures: [], stderr: [] });
                await expect(Promise.all(clients.map(client => client.request('test/ping'))))
                    .resolves.toEqual([{ pong: true }, { pong: true }]);
            } finally {
                await Promise.all(clients.map(client => client.dispose()));
                spawn.mockImplementation(originalSpawn);
            }
        });
    });

    it('uses the Codex daemon proxy transport without starting another app-server', async () => {
        await withTempDir('happier-codex-app-server-client-daemon-proxy-', async (root) => {
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "thread/loaded/list") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { data: ["thread-1"] } }) + "\\n");',
                    '  }',
                    '}',
                ],
            });
            const spawn = vi.mocked(childProcess.spawn);
            spawn.mockClear();
            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
                transport: { kind: 'daemonProxy' },
            });
            try {
                await expect(client.request('thread/loaded/list')).resolves.toEqual({ data: ['thread-1'] });
                expect(spawn.mock.calls[0]?.[1]).toEqual([
                    fakeAppServer,
                    'app-server',
                    'proxy',
                ]);
                expect(spawn.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
                    stdio: ['pipe', 'pipe', 'pipe'],
                }));
            } finally {
                await client.dispose();
            }
        });
    });

    it('speaks JSON-RPC over the shared app-server Unix WebSocket', async () => {
        await withTempDir('codex-ws-', async (root) => {
            const socketPath = process.platform === 'win32'
                ? `\\\\.\\pipe\\happier-codex-test-${process.pid}-${Date.now()}`
                : join(root, 'app-server.sock');
            const httpServer = createHttpServer();
            const webSocketServer = new WebSocketServer({
                server: httpServer,
                // Codex's tungstenite endpoint closes the handshake when clients offer
                // permessage-deflate, so keep this fixture aligned with that real boundary.
                verifyClient: (info, done) => done(info.req.headers['sec-websocket-extensions'] === undefined),
            });
            webSocketServer.on('connection', (socket) => {
                socket.on('message', (payload) => {
                    if (!Buffer.isBuffer(payload)) return;
                    const message = JSON.parse(payload.toString('utf8')) as { id?: number; method?: string };
                    if (message.method === 'initialize') {
                        socket.send(JSON.stringify({ id: message.id, result: {} }));
                    } else if (message.method === 'test/ping') {
                        socket.send(JSON.stringify({ id: message.id, result: { pong: true } }));
                    }
                });
            });
            await new Promise<void>((resolve, reject) => {
                httpServer.once('error', reject);
                httpServer.listen(socketPath, resolve);
            });

            const spawn = vi.mocked(childProcess.spawn);
            spawn.mockClear();
            const client = await createCodexAppServerClient({
                transport: { kind: 'unixWebSocket', socketPath },
            });
            try {
                await expect(client.request('test/ping')).resolves.toEqual({ pong: true });
                expect(spawn).not.toHaveBeenCalled();
            } finally {
                await client.dispose();
                await new Promise<void>((resolve, reject) => {
                    webSocketServer.close((error?: Error): void => {
                        if (error) reject(error);
                        else resolve();
                    });
                });
                await new Promise<void>((resolve) => httpServer.close(() => resolve()));
            }
        }, process.platform === 'win32' ? undefined : '/tmp');
    });

    it('settles pending requests and reports stdin failure without an uncaught stream error', async () => {
        await withTempDir('happier-codex-app-server-client-stdin-error-', async (root) => {
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n");',
                    '  }',
                    '}',
                ],
            });
            // Observe the real OS child so the injected pipe error keeps the client and cleanup path real.
            const spawn = vi.mocked(childProcess.spawn);
            spawn.mockClear();
            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
            });
            try {
                const child = spawn.mock.results.find((result) => result.type === 'return')?.value;
                if (!child?.stdin) throw new Error('Expected the app-server child stdin');
                const stdin = child.stdin;
                const exits: Error[] = [];
                client.onExit((error) => { exits.push(error); });
                const pending = client.request('pending/request', {}, { timeoutMs: null })
                    .then(() => null, (error: unknown) => error);
                const pipeError = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

                expect(() => stdin.emit('error', pipeError)).not.toThrow();
                expect(await pending).toBe(pipeError);
                expect(exits).toEqual([pipeError]);
                await expect(client.request('next/request')).rejects.toBe(pipeError);
            } finally {
                await client.dispose();
            }
        });
    });

    it.each(['timeout', 'abort'] as const)('settles %s while an OS stdin write is still pending', async (outcome) => {
        await withTempDir('happier-codex-app-server-client-pending-write-', async (root) => {
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n");',
                    '  }',
                    '}',
                ],
            });
            const spawn = vi.mocked(childProcess.spawn);
            spawn.mockClear();
            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
            });
            const child = spawn.mock.results.find((result) => result.type === 'return')?.value;
            if (!child?.stdin) throw new Error('Expected the app-server child stdin');
            const write = vi.spyOn(child.stdin, 'write').mockImplementation(() => true);
            const controller = new AbortController();
            try {
                const pending = client.request('pending/write', {}, {
                    timeoutMs: outcome === 'timeout' ? 250 : null,
                    signal: controller.signal,
                }).then(() => null, (error: unknown) => error);
                await waitForCondition(() => write.mock.calls.length > 0, {
                    timeoutMs: 1_000,
                    intervalMs: 1,
                    label: 'pending OS stdin write',
                });
                if (outcome === 'abort') controller.abort();
                const result = await Promise.race([
                    pending,
                    new Promise<'write-still-pending'>((resolve) => setTimeout(() => resolve('write-still-pending'), 1_000)),
                ]);
                expect(result).toBeInstanceOf(Error);
                expect(result).toMatchObject(outcome === 'abort'
                    ? { name: 'AbortError' }
                    : { message: 'Codex app-server request pending/write timed out after 250ms' });
            } finally {
                write.mockRestore();
                await client.dispose();
            }
        });
    });

    it('terminates the complete app-server process tree when disposed', async () => {
        await withTempDir('happier-codex-app-server-client-process-tree-', async (root) => {
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                importLines: ['import { spawn } from "node:child_process";'],
                bodyLines: [
                    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
                    'child.unref();',
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "initialized") continue;',
                    '  if (msg.method === "state/read") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { childPid: child.pid } }) + "\\n");',
                    '  }',
                    '}',
                ],
            });
            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
            });
            const result = await client.request('state/read') as { childPid: number };
            const isAlive = (): boolean => {
                try {
                    process.kill(result.childPid, 0);
                    return true;
                } catch {
                    return false;
                }
            };

            try {
                expect(isAlive()).toBe(true);
                await client.dispose();
                await waitForCondition(() => !isAlive(), {
                    timeoutMs: 2_000,
                    intervalMs: 25,
                    label: 'Codex app-server descendant to terminate on dispose',
                });
            } finally {
                if (isAlive()) process.kill(result.childPid, 'SIGKILL');
            }
        });
    });

    it('initializes once and reuses the same app-server process across multiple requests', async () => {
        await withTempDir('happier-codex-app-server-client-persistent-init-', async (root) => {
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    'let initializeCount = 0;',
                    'let initializedCount = 0;',
                    'let initializeParams = null;',
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    initializeCount += 1;',
                    '    initializeParams = msg.params ?? null;',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "initialized") {',
                    '    initializedCount += 1;',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "state/read") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { pid: process.pid, initializeCount, initializedCount, initializeParams } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                    '}',
                ],
                importLines: ['import { writeFile } from "node:fs/promises";'],
            });

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
            });

            try {
                const first = await client.request('state/read');
                const second = await client.request('state/read');

                expect(first).toEqual({
                    pid: expect.any(Number),
                    initializeCount: 1,
                    initializedCount: 1,
                    initializeParams: {
                        clientInfo: {
                            name: 'happier_cli',
                            title: 'Happier',
                            version: '0.1.0',
                        },
                        capabilities: {
                            experimentalApi: true,
                        },
                    },
                });
                expect(second).toEqual(first);
            } finally {
                await client.dispose();
            }
        });
    });

    it('always includes a params field in JSON-RPC requests (Codex app-server rejects missing params)', async () => {
        await withTempDir('happier-codex-app-server-client-requires-params-', async (root) => {
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "initialized") continue;',
                    '  if (!("params" in msg)) {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32600, message: "Invalid request: missing field `params`" } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "state/read") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true, params: msg.params } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                    '}',
                ],
            });

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
            });

            try {
                await expect(client.request('state/read')).resolves.toEqual({ ok: true, params: {} });
            } finally {
                await client.dispose();
            }
        });
    });

    it('preserves JSON-RPC error code, data, and method on request failures', async () => {
        await withTempDir('happier-codex-app-server-client-rpc-error-details-', async (root) => {
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "initialized") continue;',
                    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "Invalid params: unsupported permissions", data: { rejectedField: "permissions" } } }) + "\\n");',
                    '}',
                ],
            });

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
            });

            try {
                await expect(client.request('thread/start', { permissions: { type: 'profile', id: ':workspace' } }))
                    .rejects
                    .toMatchObject({
                        message: 'Invalid params: unsupported permissions',
                        code: -32602,
                        method: 'thread/start',
                        data: { rejectedField: 'permissions' },
                    });
            } finally {
                await client.dispose();
            }
        });
    });

    it('serializes circular request params without crashing the transport', async () => {
        await withTempDir('happier-codex-app-server-client-circular-params-', async (root) => {
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "initialized") continue;',
                    '  if (msg.method === "state/read") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { params: msg.params } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                    '}',
                ],
            });

            const circularParams: { nested: { ok: boolean }; self?: unknown } = {
                nested: { ok: true },
            };
            circularParams.self = circularParams;

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
            });

            try {
                await expect(client.request('state/read', circularParams)).resolves.toEqual({
                    params: {
                        nested: { ok: true },
                        self: '[Circular]',
                    },
                });
            } finally {
                await client.dispose();
            }
        });
    });

    it('keeps handlers active until unregistered', async () => {
        await withTempDir('happier-codex-app-server-client-persistent-handlers-', async (root) => {
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    'const serverRequestReplies = [];',
                    'const triggerRequestIds = new Map();',
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "initialized") continue;',
                    '  if (msg.method === "client/trigger") {',
                    '    const suffix = String(msg.params?.suffix ?? "one");',
                    '    triggerRequestIds.set(suffix, msg.id);',
                    '    process.stdout.write(JSON.stringify({ method: "turn/started", params: { suffix } }) + "\\n");',
                    '    process.stdout.write(JSON.stringify({ id: `server-${suffix}`, method: "server/compute", params: { suffix } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (typeof msg.id === "string" && msg.id.startsWith("server-")) {',
                    '    serverRequestReplies.push(msg.error ? { id: msg.id, error: msg.error } : { id: msg.id, result: msg.result });',
                    '    const suffix = msg.id.slice("server-".length);',
                    '    const triggerRequestId = triggerRequestIds.get(suffix);',
                    '    if (triggerRequestId !== undefined) {',
                    '      process.stdout.write(JSON.stringify({ id: triggerRequestId, result: { acknowledged: suffix } }) + "\\n");',
                    '      triggerRequestIds.delete(suffix);',
                    '    }',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "state/read") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverRequestReplies } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                    '}',
                ],
            });

            const notifications: string[] = [];
            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
            });

            try {
                const unregisterNotification = client.registerNotificationHandler('turn/started', (params: unknown) => {
                    notifications.push((params as { suffix: string }).suffix);
                });
                const unregisterRequest = client.registerRequestHandler('server/compute', (params: unknown) => {
                    return { handled: (params as { suffix: string }).suffix };
                });

                await expect(client.request('client/trigger', { suffix: 'one' })).resolves.toEqual({ acknowledged: 'one' });

                unregisterNotification();
                unregisterRequest();

                await expect(client.request('client/trigger', { suffix: 'two' })).resolves.toEqual({ acknowledged: 'two' });

                let state: {
                    serverRequestReplies: Array<unknown>;
                } = { serverRequestReplies: [] };
                await waitForCondition(
                    async () => {
                        state = await client.request('state/read') as {
                            serverRequestReplies: Array<unknown>;
                        };
                        return state.serverRequestReplies.length === 2;
                    },
                    { label: 'server request replies', timeoutMs: 500, intervalMs: 25 },
                );

                expect(state).toEqual({
                    serverRequestReplies: [
                        { id: 'server-one', result: { handled: 'one' } },
                        { id: 'server-two', error: { code: -32601, message: 'No handler registered for server/compute' } },
                    ],
                });
                expect(notifications).toEqual(['one']);
            } finally {
                await client.dispose();
            }
        });
    });

    it('rejects in-flight requests and future calls after dispose', async () => {
        await withTempDir('happier-codex-app-server-client-persistent-dispose-', async (root) => {
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "initialized") continue;',
                    '  if (msg.method === "slow/request") {',
                    '    setTimeout(() => {',
                    '      process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\\n");',
                    '    }, 250);',
                    '    continue;',
                    '  }',
                    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                    '}',
                ],
            });

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
            });

            const pending = client.request('slow/request');
            const pendingExpectation = expect(pending).rejects.toThrow('disposed');
            await client.dispose();

            await pendingExpectation;
            await expect(client.request('slow/request')).rejects.toThrow('disposed');
            await expect(client.notify('client/trigger')).rejects.toThrow('disposed');
            await expect(client.dispose()).resolves.toBeUndefined();
        });
    });

    it('rejects an in-flight request when its operation signal is aborted', async () => {
        await withTempDir('happier-codex-app-server-client-request-abort-', async (root) => {
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "initialized") continue;',
                    '}',
                ],
            });

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
            });
            const controller = new AbortController();

            try {
                const pending = client.request('slow/request', undefined, {
                    timeoutMs: null,
                    signal: controller.signal,
                });
                controller.abort();

                await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
            } finally {
                await client.dispose();
            }
        });
    });

    it('does not terminate a pending thread/resume request at the configured startup deadline', async () => {
        await withTempDir('happier-codex-app-server-client-resume-no-deadline-', async (root) => {
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "initialized") continue;',
                    '  if (msg.method === "thread/resume") {',
                    '    setTimeout(() => {',
                    '      process.stdout.write(JSON.stringify({ id: msg.id, result: { thread: { id: "thread-slow" } } }) + "\\n");',
                    '    }, 400);',
                    '  }',
                    '}',
                ],
            });

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer, {
                    HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '250',
                    HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS: '250',
                }),
            });

            try {
                await expect(client.request('thread/resume', { threadId: 'thread-slow' })).resolves.toEqual({
                    thread: { id: 'thread-slow' },
                });
            } finally {
                await client.dispose();
            }
        });
    });

    it('reads RPC timeout from the passed processEnv instead of global process.env', async () => {
        await withTempDir('happier-codex-app-server-client-timeout-env-', async (root) => {
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "initialized") continue;',
                    '  if (msg.method === "slow/request") {',
                    '    setTimeout(() => {',
                    '      process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\\n");',
                    '    }, 700);',
                    '    continue;',
                    '  }',
                    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                    '}',
                ],
            });

            const envScope = createCodexAppServerTestEnvScope();
            envScope.patch({ HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '250' });

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer, {
                    HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '1200',
                }),
            });

            try {
                await expect(client.request('slow/request')).resolves.toEqual({ ok: true });
            } finally {
                envScope.restore();
                await client.dispose();
            }
        });
    });

    it('keeps side-effecting thread/start alive past the startup RPC timeout', async () => {
        await withTempDir('happier-codex-app-server-client-thread-start-timeout-', async (root) => {
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "initialized") continue;',
                    '  if (msg.method === "thread/start") {',
                    '    setTimeout(() => {',
                    '      process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: "thread-slow-start" } }) + "\\n");',
                    '    }, 700);',
                    '    continue;',
                    '  }',
                    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                    '}',
                ],
            });

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer, {
                    HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '250',
                    HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS: '250',
                }),
            });

            try {
                await expect(client.request('thread/start')).resolves.toEqual({ threadId: 'thread-slow-start' });
            } finally {
                await client.dispose();
            }
        });
    });

    it('keeps the configured startup timeout when initialize is operation-cancellable', async () => {
        await withTempDir('happier-codex-app-server-client-cancellable-initialize-', async (root) => {
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    setTimeout(() => {',
                    '      process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    }, 700);',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "initialized") continue;',
                    '}',
                ],
            });

            const controller = new AbortController();

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer, {
                    HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '250',
                    HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS: '5000',
                }),
                initializeRequestOptions: { signal: controller.signal },
            });

            await client.dispose();
        });
    });

    it('allows a request-specific timeout override', async () => {
        await withTempDir('happier-codex-app-server-client-request-timeout-override-', async (root) => {
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "initialized") continue;',
                    '  if (msg.method === "slow/request") {',
                    '    setTimeout(() => {',
                    '      process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\\n");',
                    '    }, 700);',
                    '    continue;',
                    '  }',
                    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                    '}',
                ],
            });

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer, {
                    HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '250',
                }),
            });

            try {
                await expect(client.request('slow/request', undefined, { timeoutMs: 1200 })).resolves.toEqual({ ok: true });
            } finally {
                await client.dispose();
            }
        });
    });

    it('disposes the child process when initialize times out', async () => {
        await withTempDir('happier-codex-app-server-client-init-timeout-', async (root) => {
            const pidFile = join(root, 'pid.txt');
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid), 'utf8');`,
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") { continue; }',
                    '}',
                ],
                importLines: ['import { writeFileSync } from "node:fs";'],
            });

            await expect(createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer, {
                    HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '250',
                    HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS: '250',
                }),
            })).rejects.toThrow();

            const pid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10);
            expect(Number.isFinite(pid)).toBe(true);
            await new Promise((resolve) => setTimeout(resolve, 100));
            let alive = true;
            try {
                process.kill(pid, 0);
            } catch {
                alive = false;
            }
            expect(alive).toBe(false);
        });
    });

    it('rejects only the matching request when a newline-complete response is malformed', async () => {
        await withTempDir('happier-codex-app-server-client-correlated-invalid-json-', async (root) => {
            const pidFile = join(root, 'pid.txt');
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid), 'utf8');`,
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "initialized") continue;',
                    '  if (msg.method === "state/read") {',
                    '    process.stdout.write(`{"id":${msg.id},"result":{"payload":"unterminated}\\n`);',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "state/after") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { alive: true } }) + "\\n");',
                    '  }',
                    '}',
                ],
                importLines: ['import { writeFileSync } from "node:fs";'],
            });

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
            });
            let exitCount = 0;
            client.onExit(() => {
                exitCount += 1;
            });

            try {
                await expect(client.request('state/read')).rejects.toThrow(/Invalid Codex app-server JSON output/);
                await expect(client.request('state/after')).resolves.toEqual({ alive: true });
                expect(exitCount).toBe(0);

                const pid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10);
                expect(() => process.kill(pid, 0)).not.toThrow();
            } finally {
                await client.dispose();
            }
        });
    });

    it('closes the app-server runtime when stdout contains an uncorrelated invalid JSON-RPC frame', async () => {
        await withTempDir('happier-codex-app-server-client-invalid-json-', async (root) => {
            const pidFile = join(root, 'pid.txt');
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid), 'utf8');`,
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    continue;',
                    '  }',
                  '  if (msg.method === "initialized") continue;',
                  '  if (msg.method === "state/read") {',
                    '    process.stdout.write(`{"id":${msg.id},"method":"host/request","params":{"payload":"unterminated}\\n`);',
                    '    continue;',
                  '  }',
                    '}',
                ],
                importLines: ['import { writeFileSync } from "node:fs";'],
            });

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
            });
            const exitFailure = new Promise<Error>((resolve) => {
                client.onExit(resolve);
            });

            try {
                await expect(client.request('state/read')).rejects.toThrow(/Invalid Codex app-server JSON output/);
                await expect(Promise.race([
                    exitFailure,
                    new Promise<never>((_resolve, reject) => {
                        setTimeout(() => reject(new Error('app-server exit was not reported')), 500);
                    }),
                ])).resolves.toMatchObject({
                    message: expect.stringMatching(/Invalid Codex app-server JSON output/),
                });

                const pid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10);
                await waitForCondition(() => {
                    try {
                        process.kill(pid, 0);
                        return false;
                    } catch {
                        return true;
                    }
                }, {
                    timeoutMs: 5_000,
                    label: 'malformed-frame app-server process exit',
                });
            } finally {
                await client.dispose();
            }
        });
    });

    it('strips inherited runtime-only and RPC-log env from the app-server child process while keeping parent-side logging', async () => {
        await withTempDir('happier-codex-app-server-client-sanitize-env-', async (root) => {
            const requestLogPath = join(root, 'rpc.jsonl');
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "initialized") continue;',
                    '  if (msg.method === "state/read") {',
                    `    process.stdout.write(JSON.stringify({ id: msg.id, result: { CODEX_THREAD_ID: process.env.CODEX_THREAD_ID ?? null, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? null, HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH: process.env.HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH ?? null, ${HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY}: process.env.${HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY} ?? null, ${HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY}: process.env.${HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY} ?? null, ${HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR}: process.env.${HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR} ?? null } }) + "\\n");`,
                    '    continue;',
                    '  }',
                    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                    '}',
                ],
            });

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer, {
                    CODEX_THREAD_ID: 'poisoned-parent-thread',
                    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'poisoned-originator',
                    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: '[{"kind":"profile","serviceId":"openai-codex","profileId":"bot"}]',
                    [HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]: '["CODEX_HOME"]',
                    [HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR]: JSON.stringify([
                        HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
                        HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
                    ]),
                    HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH: requestLogPath,
                }),
            });

            try {
                await expect(client.request('state/read')).resolves.toEqual({
                    CODEX_THREAD_ID: null,
                    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: null,
                    HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH: null,
                    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: null,
                    [HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]: null,
                    [HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR]: null,
                });
            } finally {
                await client.dispose();
            }

            await expect(readFile(requestLogPath, 'utf8')).resolves.toContain('"method":"state/read"');
        });
    });

    it('redacts stderr diagnostics before attaching them to fatal app-server errors', async () => {
        await withTempDir('happier-codex-app-server-client-stderr-redaction-', async (root) => {
            const rawAccessToken = 'stderr-access-token-secret';
            const rawThreadId = 'stderr-thread-id-secret';
            const rawPath = join(root, 'codex-home', 'auth.json');
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "initialized") continue;',
                    '  if (msg.method === "state/read") {',
                    `    process.stderr.write("fatal accessToken=${rawAccessToken} CODEX_THREAD_ID=${rawThreadId} path=${rawPath}\\n");`,
                    '    process.exit(7);',
                    '  }',
                    '}',
                ],
            });

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer, {
                    HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '750',
                }),
            });

            try {
                await expect(client.request('state/read')).rejects.toSatisfy((error: unknown) => {
                    const message = error instanceof Error ? error.message : String(error);
                    expect(message).not.toContain(rawAccessToken);
                    expect(message).not.toContain(rawThreadId);
                    expect(message).not.toContain(rawPath);
                    expect(message).toContain('[REDACTED]');
                    expect(message).toContain('[REDACTED_PROVIDER_RESUME_ID]');
                    expect(message).toContain('[REDACTED_LOCAL_PATH]');
                    return true;
                });
            } finally {
                await client.dispose();
            }
        });
    });

    it('passes config overrides through as repeated -c flags to codex app-server', async () => {
        await withTempDir('happier-codex-app-server-client-config-overrides-', async (root) => {
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "initialized") continue;',
                    '  if (msg.method === "state/read") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { argv: process.argv.slice(2) } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                    '}',
                ],
            });

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
                configOverrides: [
                    'mcp_servers.happier.command="echo"',
                    'mcp_servers.happier.enabled=true',
                ],
            });

            try {
                await expect(client.request('state/read')).resolves.toEqual({
                    argv: [
                        'app-server',
                        '--listen',
                        'stdio://',
                        '-c',
                        'mcp_servers.happier.command="echo"',
                        '-c',
                        'mcp_servers.happier.enabled=true',
                    ],
                });
            } finally {
                await client.dispose();
            }
        });
    });

    it('can disable user MCP servers from CODEX_HOME/config.toml so app-server startup stays lightweight', async () => {
        await withTempDir('happier-codex-app-server-client-disable-user-mcp-', async (root) => {
            const codexHome = join(root, 'codex-home');
            await mkdir(codexHome, { recursive: true });
            await writeFile(
                join(codexHome, 'config.toml'),
                [
                    '[mcp_servers.context7]',
                    'url = "https://mcp.context7.com/mcp"',
                    '',
                    '[mcp_servers.context7.env_http_headers]',
                    'CONTEXT7_API_KEY = "CONTEXT7_API_KEY"',
                    '',
                    '[mcp_servers.playwright]',
                    'command = "npx"',
                    'args = ["-y", "@playwright/mcp@latest", "--isolated"]',
                    '',
                    '[mcp_servers.sequential-thinking]',
                    'command = "npx"',
                    'args = ["-y", "@modelcontextprotocol/server-sequential-thinking"]',
                    '',
                ].join('\n'),
                'utf8',
            );

            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "initialized") continue;',
                    '  if (msg.method === "state/read") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { argv: process.argv.slice(2) } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                    '}',
                ],
            });

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer, { CODEX_HOME: codexHome }),
                disableUserMcpServers: true,
            });

            try {
                await expect(client.request('state/read')).resolves.toEqual({
                    argv: [
                        'app-server',
                        '--listen',
                        'stdio://',
                        '-c',
                        'mcp_servers.context7.enabled=false',
                        '-c',
                        'mcp_servers.playwright.enabled=false',
                        '-c',
                        'mcp_servers.sequential-thinking.enabled=false',
                    ],
                });
            } finally {
                await client.dispose();
            }
        });
    });

    it('logs JSON-RPC traffic when HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH is set', async () => {
        await withTempDir('happier-codex-app-server-client-rpc-log-', async (root) => {
            const requestLogPath = join(root, 'rpc.jsonl');
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "initialized") continue;',
                    '  if (msg.method === "state/read") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                    '}',
                ],
            });

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer, {
                    HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH: requestLogPath,
                }),
            });

            try {
                await expect(client.request('state/read')).resolves.toEqual({ ok: true });
            } finally {
                await client.dispose();
            }

            const lines = (await readFile(requestLogPath, 'utf8'))
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as { direction: string; method?: string; result?: unknown });

            const directions = new Set(lines.map((entry) => entry.direction));
            expect(directions).toEqual(new Set(['outgoing', 'incoming']));
            expect(lines).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ direction: 'outgoing', method: 'initialize' }),
                    expect.objectContaining({ direction: 'outgoing', method: 'initialized' }),
                    expect.objectContaining({ direction: 'outgoing', method: 'state/read' }),
                ]),
            );
        });
    });

    it('redacts nested secret-bearing fields from logged JSON-RPC error data', async () => {
        await withTempDir('happier-codex-app-server-client-rpc-log-error-data-', async (root) => {
            const requestLogPath = join(root, 'rpc.jsonl');
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "initialized") continue;',
                    '  if (msg.method === "thread/start") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32001, message: "fork failed", data: { reason: "invalid auth", nested: { accessToken: "error-data-access-token-secret", idToken: "error-data-id-token-secret", auth: "error-data-auth-secret", cookie: "error-data-cookie-secret", credential: "error-data-credential-secret", privateKey: "error-data-private-key-secret", safeField: "visible" } } } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                    '}',
                ],
            });

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer, {
                    HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH: requestLogPath,
                }),
            });

            try {
                await expect(client.request('thread/start')).rejects.toMatchObject({
                    code: -32001,
                    data: expect.objectContaining({ reason: 'invalid auth' }),
                });
            } finally {
                await client.dispose();
            }

            const logText = await readFile(requestLogPath, 'utf8');
            expect(logText).toContain('"method":"thread/start"');
            expect(logText).not.toContain('error-data-access-token-secret');
            expect(logText).not.toContain('error-data-id-token-secret');
            expect(logText).not.toContain('error-data-auth-secret');
            expect(logText).not.toContain('error-data-cookie-secret');
            expect(logText).not.toContain('error-data-credential-secret');
            expect(logText).not.toContain('error-data-private-key-secret');

            const lines = logText
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as {
                    direction: string;
                    method?: string;
                    error?: {
                        code?: number;
                        data?: { nested?: Record<string, unknown> };
                    };
                });
            const errorEntry = lines.find((entry) => entry.direction === 'incoming' && entry.error?.code === -32001);
            expect(errorEntry?.error?.data?.nested).toEqual({
                accessToken: '[REDACTED]',
                idToken: '[REDACTED]',
                auth: '[REDACTED]',
                cookie: '[REDACTED]',
                credential: '[REDACTED]',
                privateKey: '[REDACTED]',
                safeField: 'visible',
            });
        });
    });

    it('redacts secret-bearing values from logged JSON-RPC error messages', async () => {
        await withTempDir('happier-codex-app-server-client-rpc-log-error-message-', async (root) => {
            const requestLogPath = join(root, 'rpc.jsonl');
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "initialized") continue;',
                    '  if (msg.method === "thread/start") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32001, message: "refresh failed Bearer rpc-secret-token accessToken=rpc-access-token" } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                    '}',
                ],
            });

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer, {
                    HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH: requestLogPath,
                }),
            });

            try {
                await expect(client.request('thread/start')).rejects.toMatchObject({
                    code: -32001,
                });
            } finally {
                await client.dispose();
            }

            const logText = await readFile(requestLogPath, 'utf8');
            expect(logText).not.toContain('rpc-secret-token');
            expect(logText).not.toContain('rpc-access-token');
            expect(logText).toContain('[REDACTED]');
        });
    });

    it('expands ~/ RPC log paths against HOME', async () => {
        await withTempDir('happier-codex-app-server-client-rpc-log-home-', async (root) => {
            const homeDir = join(root, 'home');
            const requestLogPath = join(homeDir, 'rpc.jsonl');
            await mkdir(homeDir, { recursive: true });
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "initialized") continue;',
                    '  if (msg.method === "state/read") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                    '}',
                ],
            });

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer, {
                    HOME: homeDir,
                    USERPROFILE: homeDir,
                    HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH: '~/rpc.jsonl',
                }),
            });

            try {
                await expect(client.request('state/read')).resolves.toEqual({ ok: true });
            } finally {
                await client.dispose();
            }

            const lines = (await readFile(requestLogPath, 'utf8'))
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as { direction: string; method?: string });

            expect(lines).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ direction: 'outgoing', method: 'initialize' }),
                    expect.objectContaining({ direction: 'outgoing', method: 'state/read' }),
                ]),
            );
        });
    });

    it('rotates RPC logs before appending beyond the configured cap', async () => {
        await withTempDir('happier-codex-app-server-client-rpc-log-rotation-', async (root) => {
            const requestLogPath = join(root, 'rpc.jsonl');
            await writeFile(requestLogPath, `${'x'.repeat(1_400)}\n`, 'utf8');
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "initialized") continue;',
                    '  if (msg.method === "state/read") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                    '}',
                ],
            });

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer, {
                    HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH: requestLogPath,
                    HAPPIER_CODEX_APP_SERVER_RPC_LOG_MAX_BYTES: '1800',
                }),
            });

            try {
                await expect(client.request('state/read')).resolves.toEqual({ ok: true });
            } finally {
                await client.dispose();
            }

            await expect(readFile(`${requestLogPath}.1`, 'utf8')).resolves.toContain('xxx');
            const currentLog = await readFile(requestLogPath, 'utf8');
            expect(currentLog).toContain('"method":"state/read"');
            expect(currentLog.length).toBeLessThan(1_800);
        });
    });
});
