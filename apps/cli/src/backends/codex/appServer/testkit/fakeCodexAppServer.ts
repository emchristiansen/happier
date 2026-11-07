import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';

import { WebSocketServer } from 'ws-node';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withSocketTempDir } from '@/testkit/fs/tempDir';
import {
    HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
    HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR } from '@/daemon/spawn/spawnExplicitEnvKeysMarker';

const CODEX_APP_SERVER_TEST_ENV_KEYS = [
    'HAPPIER_CODEX_APP_SERVER_BIN',
    'HAPPIER_CODEX_APP_SERVER_MAX_JSON_LINE_CHARS',
    'HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS',
    'HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS',
    'HAPPIER_CODEX_APP_SERVER_THREAD_LIST_PAGE_SIZE',
    // Missing-CLI tests must defeat a host-installed codex through the exclusive override.
    'HAPPIER_CODEX_PATH',
    'HAPPIER_TRANSCRIPT_STORAGE',
    'CODEX_HOME',
    'CODEX_SQLITE_HOME',
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
    HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
    HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR,
] as const;

export function createCodexAppServerTestEnvScope() {
    return createEnvKeyScope(CODEX_APP_SERVER_TEST_ENV_KEYS);
}

export function createCodexAppServerProcessEnv(
    fakeAppServer: string,
    overrides: Readonly<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
    return {
        ...process.env,
        HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
        HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '2000',
        // A test must select SQLite explicitly, never the controller's live native store.
        CODEX_SQLITE_HOME: undefined,
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: undefined,
        [HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]: undefined,
        [HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR]: undefined,
        ...overrides,
    };
}

export async function writeFakeCodexAppServerScript(params: Readonly<{
    dir: string;
    bodyLines: readonly string[];
    importLines?: readonly string[];
    setupLines?: readonly string[];
    fileName?: string;
    versionOutput?: string;
}>): Promise<string> {
    const scriptPath = join(params.dir, params.fileName ?? 'fake-codex-app-server.mjs');
    const script = [
        '#!/usr/bin/env node',
        ...(params.importLines ?? []),
        `if (process.argv.includes("--version")) { process.stdout.write(${JSON.stringify(`${params.versionOutput ?? 'fake-codex'}\n`)}); process.exit(0); }`,
        'import readline from "node:readline";',
        'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
        ...(params.setupLines ?? []),
        ...params.bodyLines,
    ].join('\n');
    await writeFile(scriptPath, script, { encoding: 'utf8', mode: 0o755 });
    return scriptPath;
}

/**
 * A real POSIX executable override whose app-server branch runs `appServerScript`, while its
 * separate `--version` invocation never exits. The wrapper does not `exec` its stalled child, so
 * cleanup must reach the version probe's descendant as well as the wrapper itself.
 */
/**
 * A `--version` probe that never completes. `waits`: the wrapper stays alive waiting for its
 * descendant. `exits`: the wrapper exits at once, leaving a background descendant holding the
 * inherited output pipe, as an ordinary daemonizing shell wrapper does.
 */
export async function writeStalledVersionCodexWrapper(params: Readonly<{
    dir: string;
    appServerScript: string;
    versionRoot?: 'waits' | 'exits';
}>): Promise<Readonly<{
    path: string;
    readVersionProbePids: () => Promise<number[]>;
    readLiveVersionProbePids: () => Promise<number[]>;
    killVersionProbe: () => Promise<void>;
}>> {
    const path = join(params.dir, 'stalled-version-codex');
    const versionWrapperPidPath = join(params.dir, 'version-wrapper.pid');
    const versionDescendantPidPath = join(params.dir, 'version-descendant.pid');
    const node = JSON.stringify(process.execPath);
    const stall = 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);';
    const background = params.versionRoot === 'exits' ? ' &' : '';
    await writeFile(path, [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then',
        `  echo $$ > ${JSON.stringify(versionWrapperPidPath)}`,
        `  ${node} -e '${stall}' ${JSON.stringify(versionDescendantPidPath)}${background}`,
        '  exit 0',
        'fi',
        `exec ${node} ${JSON.stringify(params.appServerScript)} "$@"`,
    ].join('\n'), { encoding: 'utf8', mode: 0o755 });
    let observedPids: number[] = [];
    const readVersionProbePids = async () => observedPids = await Promise.all([versionWrapperPidPath, versionDescendantPidPath]
        .map(async pidPath => Number.parseInt(await readFile(pidPath, 'utf8'), 10)));
    // Running now, read from the kernel: a zombie awaiting its reaper has stopped running.
    const readLiveVersionProbePids = async () => (await readVersionProbePids()).filter(isRunningProcess);
    // Fixture hygiene for a failed or timed-out test; never evidence of product cleanup.
    const killVersionProbe = async () => {
        for (const pid of await readVersionProbePids().catch(() => observedPids)) {
            try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ }
        }
    };
    return { path, readVersionProbePids, readLiveVersionProbePids, killVersionProbe };
}

function isRunningProcess(pid: number): boolean {
    try {
        const state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)?.split(' ')[0];
        return state !== undefined && state !== 'Z' && state !== 'X';
    } catch {
        return false;
    }
}

export async function writeFakeCodexAppServerThreadListScript(params: Readonly<{
    dir: string;
    nonArchivedThreads?: readonly Record<string, unknown>[];
    archivedThreads?: readonly Record<string, unknown>[];
    allowedCodexHomes?: readonly string[];
    fileName?: string;
    initializeName?: string;
    nativeItemsPath?: string;
    requestsPath?: string;
}>): Promise<string> {
    return await writeFakeCodexAppServerScript({
        dir: params.dir,
        fileName: params.fileName,
        setupLines: [
            `const nativeItemsPath = ${JSON.stringify(params.nativeItemsPath ?? null)};`,
            `const requestsPath = ${JSON.stringify(params.requestsPath ?? null)};`,
            `const nonArchivedThreads = ${JSON.stringify(params.nonArchivedThreads ?? [])};`,
            `const archivedThreads = ${JSON.stringify(params.archivedThreads ?? [])};`,
            `const allowedCodexHomes = ${JSON.stringify(params.allowedCodexHomes ?? null)};`,
            'if (Array.isArray(allowedCodexHomes) && !allowedCodexHomes.includes(process.env.CODEX_HOME ?? "")) {',
            '  process.stderr.write("unexpected CODEX_HOME\\n");',
            '  process.exit(1);',
            '}',
        ],
        bodyLines: [
            'for await (const line of rl) {',
            '  if (!line.trim()) continue;',
            '  const msg = JSON.parse(line);',
            '  if (requestsPath && msg.method) await import("node:fs/promises").then(({ appendFile }) => appendFile(requestsPath, JSON.stringify(msg) + "\\n"));',
            '  if (msg.method === "initialize") {',
            `    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: ${JSON.stringify(params.initializeName ?? 'fake-codex-app-server')}, version: "0.0.0" } } }) + "\\n");`,
            '    continue;',
            '  }',
            '  if (msg.method === "initialized") continue;',
            // Codex 0.162.1 ThreadItemsListResponse: reverse cursors include the anchor.
            '  if (msg.method === "thread/items/list" && nativeItemsPath) {',
            '    const all = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(nativeItemsPath, "utf8")));',
            '    const desc = msg.params.sortDirection === "desc";',
            '    const anchor = msg.params.cursor ? JSON.parse(msg.params.cursor) : null;',
            '    const candidates = all.map((entry, index) => ({ entry, index })).filter(({ index }) => !anchor || (desc ? (anchor.inclusive ? index <= anchor.index : index < anchor.index) : (anchor.inclusive ? index >= anchor.index : index > anchor.index)));',
            '    if (desc) candidates.reverse();',
            '    const page = candidates.slice(0, msg.params.limit ?? 100);',
            '    const cursor = (index, inclusive) => JSON.stringify({ index, inclusive });',
            '    const result = { data: page.map(({ entry }) => entry), nextCursor: candidates.length > page.length ? cursor(page.at(-1).index, false) : null, backwardsCursor: page.length ? cursor(page[0].index, true) : null };',
            '    process.stdout.write(JSON.stringify({ id: msg.id, result }) + "\\n");',
            '    continue;',
            '  }',
            '  if (msg.method === "thread/list") {',
            '    const archived = msg.params?.archived === true;',
            '    const data = archived ? archivedThreads : nonArchivedThreads;',
            '    process.stdout.write(JSON.stringify({ id: msg.id, result: { data, nextCursor: null } }) + "\\n");',
            '    continue;',
            '  }',
            '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
            '}',
        ],
    });
}

export async function writeFakeCodexAppServerProxyScript(root: string, socketPath: string): Promise<string> {
    // Codex 0.162.1 app-server proxy copies raw bytes; the caller must
    // perform the WebSocket upgrade and framing over its binary stdio.
    const fakeProxy = join(root, 'fake-codex-raw-proxy.mjs');
    await writeFile(fakeProxy, [
        '#!/usr/bin/env node',
        'import { createConnection } from "node:net";',
        `const socket = createConnection(${JSON.stringify(socketPath)});`,
        'socket.on("error", error => { process.stderr.write(String(error)); process.exitCode = 1; });',
        'process.stdin.pipe(socket);',
        'socket.pipe(process.stdout);',
    ].join('\n'), { mode: 0o755 });
    return fakeProxy;
}

export async function withFakeCodexAppServerWebSocket<T>(
    params: Readonly<{ dir: string; loadedThreadIds: readonly string[] }>,
    run: (fixture: Readonly<{ socketPath: string; proxyPath: string }>) => Promise<T>,
): Promise<T> {
    return await withSocketTempDir(async (socketDir) => {
        const socketPath = process.platform === 'win32'
            ? `\\\\.\\pipe\\happier-codex-test-${process.pid}-${Date.now()}`
            : join(socketDir, 'app-server.sock');
        const httpServer = createServer();
        const webSocketServer = new WebSocketServer({
            server: httpServer,
            // Codex's tungstenite endpoint rejects permessage-deflate during upgrade.
            verifyClient: (info, done) => done(info.req.headers['sec-websocket-extensions'] === undefined),
        });
        webSocketServer.on('connection', socket => {
            socket.on('message', payload => {
                if (!Buffer.isBuffer(payload)) return;
                const message = JSON.parse(payload.toString('utf8')) as { id?: number; method?: string };
                if (message.method === 'initialize') {
                    socket.send(JSON.stringify({ id: message.id, result: {} }));
                } else if (message.method === 'thread/loaded/list') {
                    socket.send(JSON.stringify({ id: message.id, result: { data: params.loadedThreadIds } }));
                }
            });
        });
        await new Promise<void>((resolve, reject) => {
            httpServer.once('error', reject);
            httpServer.listen(socketPath, resolve);
        });
        try {
            const proxyPath = await writeFakeCodexAppServerProxyScript(params.dir, socketPath);
            return await run({ socketPath, proxyPath });
        } finally {
            for (const socket of webSocketServer.clients) socket.terminate();
            await new Promise<void>((resolve, reject) => {
                webSocketServer.close(error => error ? reject(error) : resolve());
            });
            await new Promise<void>(resolve => httpServer.close(() => resolve()));
        }
    });
}
