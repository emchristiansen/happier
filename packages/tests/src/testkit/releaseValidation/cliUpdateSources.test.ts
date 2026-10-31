import { afterAll as j078AfterAll, beforeEach as j078BeforeEach } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cliLaunchSpecMock = vi.hoisted(() => ({
    resolveCliTestLaunchSpec: vi.fn(
        async (
            _params: { testDir: string; env: NodeJS.ProcessEnv },
            _options: { snapshotDir: string; skipDistIntegrityCheck?: boolean; skipSourceFreshnessCheck?: boolean },
        ) => ({
            command: process.execPath,
            args: ['--preserve-symlinks', '/prepared/dist/index.mjs'],
        }),
    ),
}));

vi.mock('../process/cliLaunchSpec', () => cliLaunchSpecMock);

import {
    prepareCliUpdateSourceSnapshot,
    resolveCliUpdatePublishedReleasePlan,
    resolveCliUpdateSourcePairFromEnv,
    resolveCliUpdateValidationLaunchEnv,
} from './cliUpdateSources';

describe('cli update release-validation sources', () => {
    beforeEach(() => {
        cliLaunchSpecMock.resolveCliTestLaunchSpec.mockClear();
    });

    it('J078 defaults direct test runs to local-build snapshots for both update sides', () => {
        expect(resolveCliUpdateSourcePairFromEnv({})).toEqual({
            from: { kind: 'local-build', ref: 'HEAD' },
            to: { kind: 'local-build', ref: 'HEAD' },
        });
    });

    it('J078 requires complete from/to source env when release-validation passes explicit sources', () => {
        expect(() =>
            resolveCliUpdateSourcePairFromEnv({
                HAPPIER_RELEASE_VALIDATION_CLI_UPDATE_FROM_SOURCE_KIND: 'published-channel',
                HAPPIER_RELEASE_VALIDATION_CLI_UPDATE_FROM_SOURCE_REF: 'preview',
            }),
        ).toThrow(/complete cli-update source env/i);
    });

    it('J078 resolves published channels and immutable tags to signed GitHub release assets', () => {
        expect(resolveCliUpdatePublishedReleasePlan({ kind: 'published-channel', ref: 'dev' }, 'linux', 'x64')).toEqual({
            tag: 'cli-dev',
            releaseChannel: 'publicdev',
            version: null,
            installRootName: 'cli-dev',
            archivePattern: 'happier-v*-linux-x64.tar.gz',
            checksumsPattern: 'checksums-happier-v*.txt',
            signaturePattern: 'checksums-happier-v*.txt.minisig',
        });
        expect(resolveCliUpdatePublishedReleasePlan({ kind: 'published-tag', ref: 'cli-preview' }, 'darwin', 'arm64')).toEqual({
            tag: 'cli-preview',
            releaseChannel: 'preview',
            version: null,
            installRootName: 'cli-preview',
            archivePattern: 'happier-v*-darwin-arm64.tar.gz',
            checksumsPattern: 'checksums-happier-v*.txt',
            signaturePattern: 'checksums-happier-v*.txt.minisig',
        });
        expect(resolveCliUpdatePublishedReleasePlan({ kind: 'published-tag', ref: 'cli-v1.2.3-preview.4' }, 'win32', 'x64')).toEqual({
            tag: 'cli-v1.2.3-preview.4',
            releaseChannel: 'preview',
            version: '1.2.3-preview.4',
            installRootName: 'cli-preview',
            archivePattern: 'happier-v1.2.3-preview.4-windows-x64.tar.gz',
            checksumsPattern: 'checksums-happier-v1.2.3-preview.4.txt',
            signaturePattern: 'checksums-happier-v1.2.3-preview.4.txt.minisig',
        });
    });

    it('J078 uses dist/package launch mode rather than source-entrypoint mode for update validation', () => {
        expect(
            resolveCliUpdateValidationLaunchEnv({
                HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
                HAPPY_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: 'true',
                HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
                UNRELATED: 'kept',
            }),
        ).toEqual({
            HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
            UNRELATED: 'kept',
        });
    });

    it('J078 materializes local-build sources as prepared dist snapshots for later artifact-only validation', async () => {
        await expect(
            prepareCliUpdateSourceSnapshot({
                testDir: '/tmp/happier-cli-update-test',
                role: 'to',
                source: { kind: 'local-build', ref: 'HEAD' },
                env: {
                    HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
                },
            }),
        ).resolves.toBe('/prepared');

        expect(cliLaunchSpecMock.resolveCliTestLaunchSpec).toHaveBeenCalledTimes(1);
        expect(cliLaunchSpecMock.resolveCliTestLaunchSpec).toHaveBeenCalledWith(
            {
                testDir: '/tmp/happier-cli-update-test',
                env: expect.objectContaining({
                    HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'symlink',
                }),
            },
            expect.objectContaining({
                snapshotDir: '/tmp/happier-cli-update-test/cli-update-to',
                skipDistIntegrityCheck: true,
                skipSourceFreshnessCheck: true,
            }),
        );
        expect(cliLaunchSpecMock.resolveCliTestLaunchSpec.mock.calls[0]?.[0].env).not.toHaveProperty(
            'HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT',
        );
    });
});


// J078: install genuine system boundaries before the real owners load. Fixture cp remains real.
const j078Boundary = await vi.hoisted(async () => {
  const { createRequire, syncBuiltinESMExports } = await import('node:module');
  const req = createRequire(`${process.cwd()}/package.json`);
  const fs = req('node:fs');
  const promises = req('node:fs/promises');
  const cp = req('node:child_process');
  const http = req('node:http');
  const https = req('node:https');
  const net = req('node:net');
  const original = { read: fs.readFileSync, cpSync: fs.cpSync, cp: promises.cp, kill: process.kill, fetch: globalThis.fetch,
    child: Object.fromEntries(['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'].map((key) => [key, cp[key]])),
    httpRequest: http.request, httpsRequest: https.request, httpServer: http.createServer, netServer: net.createServer };
  const state = { active: true, attempts: [] as string[], onCopy: null as null | ((src: string, dest: string, run: () => Promise<void>) => Promise<void>) };
  const refuse = (name: string) => (..._args: unknown[]) => { state.attempts.push(name); throw new Error(`J078 forbidden external boundary: ${name}`); };
  for (const key of Object.keys(original.child)) cp[key] = (...args: unknown[]) => state.active ? refuse(key)(...args) : original.child[key](...args);
  http.request = (...args: unknown[]) => state.active ? refuse('http')(...args) : original.httpRequest(...args);
  https.request = (...args: unknown[]) => state.active ? refuse('https')(...args) : original.httpsRequest(...args);
  http.createServer = (...args: unknown[]) => state.active ? refuse('server')(...args) : original.httpServer(...args);
  net.createServer = (...args: unknown[]) => state.active ? refuse('net')(...args) : original.netServer(...args);
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => state.active ? refuse('fetch')(...args) : original.fetch(...args)) as typeof fetch;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (!state.active) return original.kill(pid, signal);
    if (signal !== 0) return refuse('signal')(pid, signal);
    return true; // Fixture liveness only; never send signal 0.
  }) as typeof process.kill;
  fs.readFileSync = (...args: unknown[]) => state.active && typeof args[0] === 'string' && /^\/proc\/\d+\/stat$/.test(args[0])
    ? `1 (fixture) S ${Array(18).fill('0').join(' ')} 100` : original.read(...args);
  const allowed = (path: unknown) => {
    const root = process.env.TMPDIR;
    if (!root || typeof path !== 'string' || !(path === root || path.startsWith(`${root}/`))) {
      throw new Error(`J078 fixture copy outside owned TMPDIR: ${String(path)}`);
    }
  };
  fs.cpSync = (...args: unknown[]) => { if (state.active) { allowed(args[0]); allowed(args[1]); } return original.cpSync(...args); };
  promises.cp = async (src: string, dest: string, ...args: unknown[]) => {
    if (state.active) { allowed(src); allowed(dest); }
    const run = () => original.cp(src, dest, ...args) as Promise<void>;
    return state.active && state.onCopy ? state.onCopy(src, dest, run) : run();
  };
  syncBuiltinESMExports();
  if ((await import('node:child_process')).spawnSync !== cp.spawnSync
    || (await import('node:fs')).readFileSync !== fs.readFileSync
    || (await import('node:fs/promises')).cp !== promises.cp) throw new Error('J078 actual builtin binding mismatch');
  return { state, restore: () => {
    fs.readFileSync = original.read; fs.cpSync = original.cpSync; promises.cp = original.cp;
    for (const key of Object.keys(original.child)) cp[key] = original.child[key];
    http.request = original.httpRequest; https.request = original.httpsRequest;
    http.createServer = original.httpServer; net.createServer = original.netServer;
    process.kill = original.kill; globalThis.fetch = original.fetch; syncBuiltinESMExports();
  } };
});
// Unselected legacy cases retain their own existing boundaries and assertions.
j078BeforeEach(() => { j078Boundary.state.active = Boolean(expect.getState().currentTestName?.includes('J078')); });
j078AfterAll(() => {
  try { expect(j078Boundary.state.attempts).toEqual([]); }
  finally { j078Boundary.restore(); }
});

const j078Acquisition = vi.hoisted(() => ({ root: null as null | string, command: vi.fn(), commandExport: null as unknown }));
vi.mock('../paths', async (original) => {
  const actual = await original<typeof import('../paths')>();
  return { ...actual, repoRootDir: () => j078Acquisition.root ?? actual.repoRootDir() };
});
vi.mock('../process/spawnProcess', async (original) => {
  const actual = await original<typeof import('../process/spawnProcess')>();
  const command = (...args: Parameters<typeof actual.runLoggedCommand>) => j078Acquisition.root ? j078Acquisition.command(...args) : actual.runLoggedCommand(...args);
  j078Acquisition.commandExport = command;
  return { ...actual, runLoggedCommand: command };
});

describe('J078 update-source producer lifetime', () => {
  it('J078 propagates the actual local-build generation instead of reconstructing the requested path', async () => {
    cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValueOnce({ command: process.execPath, args: ['--preserve-symlinks', '/fixture/generation-A/dist/index.mjs'] });
    cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValueOnce({ command: process.execPath, args: ['--preserve-symlinks', '/fixture/generation-B/dist/index.mjs'] });
    const params = { testDir: '/fixture', role: 'to' as const, source: { kind: 'local-build' as const, ref: 'HEAD' }, env: {} };
    expect(await prepareCliUpdateSourceSnapshot(params)).toBe('/fixture/generation-A');
    expect(await prepareCliUpdateSourceSnapshot(params)).toBe('/fixture/generation-B');
  });
  it.each(['published-tag', 'local-pack'] as const)('J078 retains earlier %s inputs and owned lazy files on repeated same-role preparation', async (kind) => {
    const fs = await import('node:fs/promises'); const path = await import('node:path'); const os = await import('node:os');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'j078-update-')); j078Acquisition.root = root;
    let acquisition = 0;
    try {
      j078Acquisition.command.mockImplementation(async (params: { command: string; args: string[]; env: NodeJS.ProcessEnv }) => {
        if (params.command === 'gh') {
          expect(params.args.slice(0, 3)).toEqual(['release', 'download', 'cli-v1.2.3-preview.4']);
          expect(params.args).toContain('--repo'); return;
        }
        let payload: string; let entry: string;
        if (params.command === 'tar') {
          expect(params.args[0]).toBe('-xzf');
          payload = path.resolve(params.args[params.args.indexOf('-C') + 1], 'package'); entry = 'dist';
        } else if (params.command === 'bash' || params.command === 'pwsh') {
          expect(params.env.HAPPIER_WITH_DAEMON).toBe('0');
          payload = path.resolve(params.env.HAPPIER_INSTALL_DIR!, 'cli-preview', 'current'); entry = 'package-dist';
        } else throw new Error(`Unexpected acquisition command: ${params.command}`);
        acquisition += 1;
        await fs.mkdir(path.resolve(payload, entry), { recursive: true });
        await fs.mkdir(path.resolve(payload, 'node_modules', 'lazy'), { recursive: true });
        await fs.writeFile(path.resolve(payload, 'package.json'), '{"name":"fixture-cli"}');
        await fs.writeFile(path.resolve(payload, entry, 'index.mjs'), `export const generation = ${acquisition};`);
        await fs.writeFile(path.resolve(payload, 'node_modules', 'lazy', 'index.js'), `lazy-${acquisition}`);
      });
      expect((await import('../process/spawnProcess')).runLoggedCommand).toBe(j078Acquisition.commandExport);
      const params = { testDir: root, role: 'to' as const, source: { kind, ref: kind === 'published-tag' ? 'cli-v1.2.3-preview.4' : path.resolve(root, 'fixture.tgz') }, env: {} };
      const a = await prepareCliUpdateSourceSnapshot(params); const b = await prepareCliUpdateSourceSnapshot(params);
      expect(a).not.toBe(b);
      const entry = kind === 'published-tag' ? 'package-dist' : 'dist';
      expect(await fs.readFile(path.resolve(a, entry, 'index.mjs'), 'utf8')).toContain('= 1');
      expect(await fs.readFile(path.resolve(a, 'node_modules', 'lazy', 'index.js'), 'utf8')).toBe('lazy-1');
      expect(await fs.readFile(path.resolve(b, entry, 'index.mjs'), 'utf8')).toContain('= 2');
    } finally { j078Acquisition.root = null; await fs.rm(root, { recursive: true, force: true }); }
  });
});
