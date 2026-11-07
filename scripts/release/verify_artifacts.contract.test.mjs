import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import * as tar from 'tar';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const verifyArtifactsPath = resolve(repoRoot, 'scripts', 'pipeline', 'release', 'verify-artifacts.mjs');

function normalizeArchivePlatform(platform) {
  return platform === 'win32' ? 'windows' : platform;
}

function normalizeArchiveArch(arch) {
  if (arch === 'x86_64' || arch === 'amd64') return 'x64';
  if (arch === 'aarch64') return 'arm64';
  return arch;
}

async function sha256(path) {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

// Real signed archive fixtures exercise the same envelope consumed by acquisition.
async function createComponentFixture({ product = 'happier-difftastic', foreign = false, files } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-component-'));
  const artifactsDir = join(workspace, 'artifacts');
  const os = foreign ? (process.platform === 'linux' ? 'windows' : 'linux') : normalizeArchivePlatform(process.platform);
  const arch = foreign ? 'x64' : normalizeArchiveArch(process.arch);
  const archiveStem = `${product}-v1.2.3-${os}-${arch}`;
  const archiveName = `${archiveStem}.tar.gz`;
  const stageRoot = join(workspace, 'stage');
  await mkdir(artifactsDir);
  await mkdir(join(stageRoot, archiveStem), { recursive: true });
  for (const [name, content] of Object.entries(files ?? { [os === 'windows' ? 'difft.exe' : 'difft']: foreign ? 'foreign native executable' : '#!/usr/bin/env node\nconsole.log("difftastic 0.64.0");\n' })) {
    const path = join(stageRoot, archiveStem, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { mode: 0o755 });
  }
  await tar.c({ gzip: true, cwd: stageRoot, file: join(artifactsDir, archiveName) }, [archiveStem]);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyId = Buffer.alloc(8, 1);
  const publicKeyPath = join(workspace, 'public.key');
  await writeFile(publicKeyPath, `untrusted comment: test key\n${Buffer.concat([Buffer.from('Ed'), keyId, publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)]).toString('base64')}\n`);
  const seal = async (path, text) => {
    await writeFile(path, text);
    const signature = sign(null, Buffer.from(text), privateKey);
    const suffix = Buffer.from('test');
    await writeFile(`${path}.minisig`, `untrusted comment: test\n${Buffer.concat([Buffer.from('Ed'), keyId, signature]).toString('base64')}\ntrusted comment: test\n${sign(null, Buffer.concat([signature, suffix]), privateKey).toString('base64')}\n`);
  };
  const componentChecksumsPath = join(artifactsDir, `checksums-${product}-v1.2.3.txt`);
  await seal(componentChecksumsPath, `${await sha256(join(artifactsDir, archiveName))}  ${archiveName}\n`);
  const checksumsPath = join(artifactsDir, 'checksums-release-v1.2.3.txt');
  const resealPrimary = async () => {
    const names = [archiveName, basename(componentChecksumsPath), `${basename(componentChecksumsPath)}.minisig`];
    await writeFile(checksumsPath, (await Promise.all(names.map(async (name) => `${await sha256(join(artifactsDir, name))}  ${name}\n`))).join(''));
  };
  await resealPrimary();
  const run = (args = [], env = process.env) => JSON.parse(execFileSync(process.execPath, [verifyArtifactsPath, '--artifacts-dir', artifactsDir, '--checksums', checksumsPath, '--public-key', publicKeyPath, ...args], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe', env }));
  return { workspace, artifactsDir, archiveName, stageRoot, archiveStem, componentChecksumsPath, checksumsPath, resealPrimary, seal, run };
}

function createBaseCliRuntimeSmokeFixtureFiles(version) {
  const markerWrite = "appendFileSync(process.env.HAPPIER_TEST_RUNTIME_SMOKE_MARKER, ";
  return {
    happier: `#!/usr/bin/env bash\nprintf '%s\\n' '${version}'\n`,
    'tools/unpacked/rg': `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == '--version' ]]; then
  printf 'rg-version\\n' >> "$HAPPIER_TEST_RUNTIME_SMOKE_MARKER"
  printf 'ripgrep 14.1.0\\n'
  exit 0
fi
printf 'rg-search\\n' >> "$HAPPIER_TEST_RUNTIME_SMOKE_MARKER"
pattern="\${@: -2:1}"
file="\${@: -1}"
grep -F -- "$pattern" "$file"
`,
    'tools/unpacked/zellij': `#!/usr/bin/env bash
set -euo pipefail
[[ "\${1:-}" == '--version' ]]
printf 'zellij-version\\n' >> "$HAPPIER_TEST_RUNTIME_SMOKE_MARKER"
printf 'zellij 0.44.3\\n'
`,
    'package-dist/index.mjs': `
      import { appendFileSync } from 'node:fs';
      if (!process.argv.includes('--version')) throw new Error('package-dist version flag missing');
      if (process.env.NODE_PATH) throw new Error('package-dist inherited NODE_PATH');
      ${markerWrite}'package-dist-version\\n');
      console.log(${JSON.stringify(version)});
    `,
    'node_modules/@anthropic-ai/claude-agent-sdk/package.json': JSON.stringify({
      name: '@anthropic-ai/claude-agent-sdk', type: 'module', exports: { '.': './sdk.mjs' },
    }),
    'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs': `
      import { appendFileSync, readFileSync } from 'node:fs';
      const mark = (value) => appendFileSync(process.env.HAPPIER_TEST_RUNTIME_SMOKE_MARKER, value + '\\n');
      export const tool = (name, description, inputSchema, handler) => ({ name, description, inputSchema, handler });
      export function createSdkMcpServer({ name, tools }) {
        mark('sdk-mcp-server');
        return { type: 'sdk', name, instance: {
          async connect(transport) { transport.server = { tools }; },
          async close() {},
        } };
      }
      export function query({ prompt, options }) {
        if (prompt !== 'runtime-smoke') throw new Error('unexpected Claude SDK smoke prompt');
        if (options.executable !== process.execPath) throw new Error('Claude SDK runtime executable is not explicit');
        if (process.env.NODE_PATH || options.env.NODE_PATH) throw new Error('Claude SDK smoke inherited NODE_PATH');
        if (!readFileSync(options.pathToClaudeCodeExecutable, 'utf8').includes('fixture-ok')) {
          throw new Error('Claude SDK fixture executable was not generated');
        }
        return {
          async next() {
            mark('claude-query');
            return { done: false, value: { type: 'result', result: 'fixture-ok' } };
          },
          close() {},
        };
      }
    `,
    'node_modules/@modelcontextprotocol/sdk/package.json': JSON.stringify({
      name: '@modelcontextprotocol/sdk', type: 'module',
      exports: {
        './client/index.js': { require: './dist/cjs/client/index.cjs' },
        './inMemory.js': { require: './dist/cjs/inMemory.cjs' },
      },
    }),
    'node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.cjs': `
      const { appendFileSync } = require('node:fs');
      appendFileSync(process.env.HAPPIER_TEST_RUNTIME_SMOKE_MARKER, 'mcp-cjs\\n');
      const mark = (value) => appendFileSync(process.env.HAPPIER_TEST_RUNTIME_SMOKE_MARKER, value + '\\n');
      exports.Client = class Client {
        async connect(transport) { this.transport = transport; }
        async ping() { if (!this.transport.other.server) throw new Error('MCP server missing'); mark('mcp-ping'); return {}; }
        async listTools() { mark('mcp-list'); return { tools: this.transport.other.server.tools }; }
        async callTool({ name, arguments: args }) {
          mark('mcp-call');
          return await this.transport.other.server.tools.find((entry) => entry.name === name).handler(args);
        }
        async close() {}
      };
    `,
    'node_modules/@modelcontextprotocol/sdk/dist/cjs/inMemory.cjs': `
      exports.InMemoryTransport = class InMemoryTransport {
        static createLinkedPair() {
          const client = {};
          const server = {};
          client.other = server;
          server.other = client;
          return [client, server];
        }
      };
    `,
    'node_modules/zod/package.json': JSON.stringify({
      name: 'zod', type: 'module', exports: { '.': { import: './index.js', require: './index.cjs' } },
    }),
    'node_modules/zod/index.js': "export const z = { string: () => ({ type: 'string' }) };\n",
    'node_modules/zod/index.cjs': "exports.z = { string: () => ({ type: 'string' }) };\n",
    'node_modules/sharp/package.json': JSON.stringify({ name: 'sharp', main: './index.cjs' }),
    'node_modules/sharp/index.cjs': `
      const { appendFileSync } = require('node:fs');
      module.exports = function sharp({ create }) {
        if (create.width !== 1 || create.height !== 1) throw new Error('sharp smoke must encode 1x1');
        return { png: () => ({ toBuffer: async () => {
          appendFileSync(process.env.HAPPIER_TEST_RUNTIME_SMOKE_MARKER, 'sharp\\n');
          return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
        } }) };
      };
    `,
    'node_modules/@homebridge/node-pty-prebuilt-multiarch/package.json': JSON.stringify({
      name: '@homebridge/node-pty-prebuilt-multiarch', main: './index.cjs',
    }),
    'node_modules/@homebridge/node-pty-prebuilt-multiarch/index.cjs': `
      require('node:fs').appendFileSync(process.env.HAPPIER_TEST_RUNTIME_SMOKE_MARKER, 'homebridge\\n');
      exports.spawn = () => {};
    `,
    'node_modules/node-pty/package.json': JSON.stringify({ name: 'node-pty', main: './index.cjs' }),
    'node_modules/node-pty/index.cjs': `
      const childProcess = require('node:child_process');
      const { appendFileSync } = require('node:fs');
      exports.spawn = (command, args, options) => {
        if (process.platform !== 'win32' && (command !== '/bin/sh' || args.join(' ') !== '-c printf pty-ok')) {
          throw new Error('node-pty smoke did not use the real POSIX shell recipe');
        }
        appendFileSync(process.env.HAPPIER_TEST_RUNTIME_SMOKE_MARKER, 'node-pty\\n');
        const child = childProcess.spawn(command, args, { cwd: options.cwd, env: options.env });
        return {
          onData(handler) { child.stdout.on('data', (chunk) => handler(chunk.toString())); },
          onExit(handler) { child.on('exit', (exitCode, signal) => handler({ exitCode, signal })); },
        };
      };
    `,
  };
}

test('verify-artifacts accepts signed component envelopes and foreign layouts without executing foreign binaries', async () => {
  const fixture = await createComponentFixture({ foreign: true });
  try {
    await fixture.seal(fixture.checksumsPath, await readFile(fixture.checksumsPath, 'utf8'));
    const result = fixture.run();
    assert.deepEqual(result.verifiedArchives, [fixture.archiveName]);
    assert.deepEqual(result.verifiedComponentEnvelopes, [basename(fixture.componentChecksumsPath)]);
  } finally { await rm(fixture.workspace, { recursive: true, force: true }); }
});

for (const product of ['happier', 'happier-memory-runtime', 'happier-difftastic']) {
  test(`verify-artifacts applies canonical traversal validation to foreign ${product} archives even with --skip-smoke`, async () => {
    const fixture = await createComponentFixture({ product, foreign: true });
    try {
      await tar.c({ gzip: true, prefix: '../escape', cwd: fixture.stageRoot, file: join(fixture.artifactsDir, fixture.archiveName) }, [fixture.archiveStem]);
      await fixture.seal(fixture.componentChecksumsPath, `${await sha256(join(fixture.artifactsDir, fixture.archiveName))}  ${fixture.archiveName}\n`);
      await fixture.resealPrimary();
      assert.throws(() => fixture.run(['--skip-smoke']), /archive entry.*non-portable path/i);
    } finally { await rm(fixture.workspace, { recursive: true, force: true }); }
  });
}

test('verify-artifacts verifies component signatures even when the primary envelope is valid and smoke is skipped', async () => {
  const fixture = await createComponentFixture({ foreign: true });
  try {
    await writeFile(`${fixture.componentChecksumsPath}.minisig`, 'invalid component signature');
    await fixture.resealPrimary();
    assert.throws(() => fixture.run(['--skip-smoke']), /signature verification failed/i);
  } finally { await rm(fixture.workspace, { recursive: true, force: true }); }
});

test('verify-artifacts checks the component checksum against its archive independently of the primary envelope', async () => {
  const fixture = await createComponentFixture({ foreign: true });
  try {
    await fixture.seal(fixture.componentChecksumsPath, `${'0'.repeat(64)}  ${fixture.archiveName}\n`);
    await fixture.resealPrimary();
    assert.throws(() => fixture.run(['--skip-smoke']), /checksum mismatch/i);
  } finally { await rm(fixture.workspace, { recursive: true, force: true }); }
});

test('verify-artifacts validates foreign component layouts without executing them', async () => {
  const fixture = await createComponentFixture({ foreign: true, files: { 'LICENSE.txt': 'license' } });
  try {
    assert.throws(() => fixture.run(['--skip-smoke']), /missing.*entrypoint|ENOENT/i);
  } finally { await rm(fixture.workspace, { recursive: true, force: true }); }
});

test('verify-artifacts runs the native difftastic component', async () => {
  const fixture = await createComponentFixture({ files: { difft: '#!/usr/bin/env node\nconsole.error("difft smoke reached"); process.exit(7);\n' } });
  try {
    assert.throws(() => fixture.run(), /difft smoke reached/);
  } finally { await rm(fixture.workspace, { recursive: true, force: true }); }
});

test('verify-artifacts rejects a timed-out difftastic version smoke even when it prints version output', async () => {
  const fixture = await createComponentFixture({
    files: {
      difft: [
        '#!/usr/bin/env bash',
        "printf 'difftastic version 0.64.0\\n'",
        'while true; do sleep 1; done',
        '',
      ].join('\n'),
    },
  });
  try {
    assert.throws(
      () => fixture.run([], { ...process.env, HAPPIER_RELEASE_BINARY_SMOKE_TIMEOUT_MS: '500' }),
      /smoke test timed out/i,
    );
  } finally { await rm(fixture.workspace, { recursive: true, force: true }); }
});

test('verify-artifacts imports the native memory runtime instead of accepting an unopened module', async () => {
  const fixture = await createComponentFixture({ product: 'happier-memory-runtime', files: { 'node_modules/@huggingface/transformers/dist/transformers.node.mjs': 'throw new Error("memory smoke reached");' } });
  try {
    assert.throws(() => fixture.run(), /memory smoke reached/);
  } finally { await rm(fixture.workspace, { recursive: true, force: true }); }
});

test('verify-artifacts exercises the Transformers ONNX tensor boundary with remote models disabled', async () => {
  // Third-party module fixture distinguishes import-only smoke from the ONNX value boundary.
  const fixture = await createComponentFixture({ product: 'happier-memory-runtime', files: {
    'node_modules/@huggingface/transformers/dist/transformers.node.mjs': `
      export const env = { allowRemoteModels: true };
      export class Tensor {
        constructor() {
          if (env.allowRemoteModels) throw new Error('remote models must be disabled');
          throw new Error('ONNX tensor boundary reached');
        }
      }
    `,
  } });
  try {
    assert.throws(() => fixture.run(), /ONNX tensor boundary reached/);
  } finally { await rm(fixture.workspace, { recursive: true, force: true }); }
});

test('verify-artifacts requires explicit checksums when component envelopes coexist', async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), 'happier-verify-envelopes-'));
  const primaryPath = join(artifactsDir, 'checksums-happier-v1.2.3.txt');
  const run = (args = []) => execFileSync(process.execPath, [
    verifyArtifactsPath, '--artifacts-dir', artifactsDir, '--skip-smoke', ...args,
  ], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
  try {
    const metadataPath = join(artifactsDir, 'metadata.json');
    await writeFile(metadataPath, '{}');
    const checksums = `${await sha256(metadataPath)}  metadata.json\n`;
    await writeFile(primaryPath, checksums);
    assert.equal(JSON.parse(run()).checksumsPath, primaryPath);
    await writeFile(join(artifactsDir, 'checksums-happier-difftastic-v1.2.3.txt'), checksums);
    await writeFile(join(artifactsDir, 'checksums-happier-memory-runtime-v1.2.3.txt'), checksums);
    assert.throws(() => run(), /multiple checksums.*--checksums/i);
    const explicit = JSON.parse(run(['--checksums', primaryPath]));
    assert.equal(explicit.checksumsPath, primaryPath);
    assert.deepEqual(explicit.verified, ['metadata.json']);
  } finally {
    await rm(artifactsDir, { recursive: true, force: true });
  }
});

test('opaque APK verification does not require binary-runtime build products', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-apk-'));
  const artifactsDir = join(workspace, 'artifacts');
  await mkdir(artifactsDir);
  const loader = join(workspace, 'unavailable-binary-runtime.mjs');
  // Model the package-resolution boundary of the release-runtime-only APK job,
  // without deleting another worker's cli-common build products.
  await writeFile(loader, `export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@happier-dev/cli-common')) {
      throw Object.assign(new Error('Binary runtime package is not built in the opaque publisher'), { code: 'ERR_MODULE_NOT_FOUND' });
    }
    return nextResolve(specifier, context);
  }\n`);
  const apkPath = join(artifactsDir, 'happier-stable-android.apk');
  const checksumsPath = join(artifactsDir, 'checksums-ui-mobile.txt');
  const run = () => JSON.parse(execFileSync(process.execPath, [
    '--experimental-loader', loader, verifyArtifactsPath,
    '--artifacts-dir', artifactsDir, '--checksums', checksumsPath,
  ], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' }));
  try {
    await writeFile(apkPath, 'opaque APK fixture');
    await writeFile(checksumsPath, `${await sha256(apkPath)}  ${basename(apkPath)}\n`);
    assert.deepEqual(run().verified, [basename(apkPath)]);
    await writeFile(apkPath, 'tampered APK');
    assert.throws(run, /checksum mismatch/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts enforces required signatures only when requested', async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), 'happier-verify-signature-'));
  const checksumsPath = join(artifactsDir, 'checksums-happier-v1.2.3.txt');
  const run = (args = []) => execFileSync(process.execPath, [
    verifyArtifactsPath, '--artifacts-dir', artifactsDir, '--checksums', checksumsPath, '--skip-smoke', ...args,
  ], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
  try {
    const metadataPath = join(artifactsDir, 'metadata.json');
    await writeFile(metadataPath, '{}');
    await writeFile(checksumsPath, `${await sha256(metadataPath)}  metadata.json\n`);
    assert.equal(JSON.parse(run()).ok, true);
    assert.throws(() => run(['--require-signature']), /required.*signature.*missing|missing.*required.*signature/i);
  } finally {
    await rm(artifactsDir, { recursive: true, force: true });
  }
});

test('verify-artifacts strictly covers native products, evidence, and manifests while excluding control files', async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), 'happier-verify-complete-'));
  const checksumsPath = join(artifactsDir, 'checksums-happier-v1.2.3.txt');
  const run = (args = []) => execFileSync(process.execPath, [
    verifyArtifactsPath, '--artifacts-dir', artifactsDir, '--checksums', checksumsPath, '--skip-smoke', ...args,
  ], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
  try {
    const metadataPath = join(artifactsDir, 'metadata.json');
    await writeFile(metadataPath, '{}');
    const initialChecksums = `${await sha256(metadataPath)}  metadata.json\n`;
    await writeFile(checksumsPath, initialChecksums);
    for (const name of ['control.json', 'checksums-happier-difftastic-v1.2.3.txt', 'checksums-happier-difftastic-v1.2.3.txt.minisig']) {
      await writeFile(join(artifactsDir, name), 'control');
    }
    assert.equal(JSON.parse(run(['--require-all-artifacts-checksummed'])).ok, true);
    const otherOs = process.platform === 'linux' ? 'windows' : 'linux';
    const artifactNames = [
      ...['happier', 'happier-memory-runtime', 'happier-difftastic'].map((product) => `${product}-v1.2.3-${otherOs}-x64.tar.gz`),
      'darwin-arm64.cli.json',
      'darwin-x64.happier-memory-runtime.json',
      'darwin-x64.json',
      'latest.json',
    ];
    for (const name of artifactNames) {
      const archivePath = join(artifactsDir, name);
      await writeFile(archivePath, 'archive');
      assert.equal(JSON.parse(run()).ok, true);
      assert.throws(() => run(['--require-all-artifacts-checksummed']), /artifact.*not.*checksumm|artifact.*missing.*checksum/i);
      if (!name.endsWith('.tar.gz')) {
        await writeFile(checksumsPath, `${initialChecksums}${await sha256(archivePath)}  ${name}\n`);
        assert.ok(JSON.parse(run(['--require-all-artifacts-checksummed'])).verified.includes(name));
      }
      await rm(archivePath);
      await writeFile(checksumsPath, initialChecksums);
    }
  } finally {
    await rm(artifactsDir, { recursive: true, force: true });
  }
});

test('verify-artifacts smoke-runs packaged server binaries with isolated startup env instead of --help', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-server-'));
  try {
    const artifactsDir = join(workspace, 'artifacts');
    const stageRoot = join(workspace, 'stage');
    const archivePlatform = normalizeArchivePlatform(process.platform);
    const archiveArch = normalizeArchiveArch(process.arch);
    const archiveStem = `happier-server-v0.0.0-test-${archivePlatform}-${archiveArch}`;
    const stageDir = join(stageRoot, archiveStem);
    const markerPath = join(workspace, 'server-smoke-marker.txt');
    const archivePath = join(artifactsDir, `${archiveStem}.tar.gz`);
    const checksumsPath = join(artifactsDir, 'checksums-happier-server-v0.0.0-test.txt');

    await mkdir(stageDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(stageDir, 'happier-server'),
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'if [[ "${1-}" == "--help" ]]; then',
        '  echo "server smoke should not use --help"',
        '  exit 1',
        'fi',
        '[[ "${PORT-}" == "0" ]] || { echo "expected PORT=0 but got ${PORT-}"; exit 1; }',
        '[[ "${METRICS_PORT-}" == "0" ]] || { echo "expected METRICS_PORT=0 but got ${METRICS_PORT-}"; exit 1; }',
        '[[ -n "${HAPPIER_SERVER_LIGHT_DATA_DIR-}" ]] || { echo "missing HAPPIER_SERVER_LIGHT_DATA_DIR"; exit 1; }',
        `printf 'PORT=%s\\nMETRICS_PORT=%s\\nDATA=%s\\n' "$PORT" "$METRICS_PORT" "$HAPPIER_SERVER_LIGHT_DATA_DIR" > "${markerPath}"`,
        'exec sleep 30',
        '',
      ].join('\n'),
      { encoding: 'utf-8', mode: 0o755 },
    );

    execFileSync('tar', ['-czf', archivePath, '-C', stageRoot, archiveStem], { cwd: repoRoot });
    await writeFile(
      checksumsPath,
      `${await sha256(archivePath)}  ${archiveStem}.tar.gz\n`,
      'utf-8',
    );

    execFileSync(
      process.execPath,
      [
        verifyArtifactsPath,
        '--artifacts-dir',
        artifactsDir,
        '--checksums',
        checksumsPath,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HAPPIER_SERVER_LIGHT_DATA_DIR: '',
          // The full release-contract collector starts hundreds of subprocesses
          // in parallel. Preserve a tight bound while allowing this fixture's
          // shell enough time to be scheduled and write its environment proof.
          HAPPIER_RELEASE_SERVER_SMOKE_TIMEOUT_MS: '3000',
          PORT: '',
          METRICS_PORT: '',
        },
        stdio: 'pipe',
      },
    );

    const marker = await readFile(markerPath, 'utf-8');
    assert.match(marker, /^PORT=0$/m);
    assert.match(marker, /^METRICS_PORT=0$/m);
    assert.match(marker, /^DATA=.+$/m);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts rejects a packaged server binary that exits before the smoke window', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-server-early-exit-'));
  try {
    const artifactsDir = join(workspace, 'artifacts');
    const stageRoot = join(workspace, 'stage');
    const archivePlatform = normalizeArchivePlatform(process.platform);
    const archiveArch = normalizeArchiveArch(process.arch);
    const archiveStem = `happier-server-v0.0.0-early-exit-${archivePlatform}-${archiveArch}`;
    const stageDir = join(stageRoot, archiveStem);
    const archivePath = join(artifactsDir, `${archiveStem}.tar.gz`);
    const checksumsPath = join(artifactsDir, 'checksums-happier-server-v0.0.0-early-exit.txt');

    await mkdir(stageDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(stageDir, 'happier-server'),
      '#!/usr/bin/env bash\nexit 0\n',
      { encoding: 'utf-8', mode: 0o755 },
    );

    execFileSync('tar', ['-czf', archivePath, '-C', stageRoot, archiveStem], { cwd: repoRoot });
    await writeFile(
      checksumsPath,
      `${await sha256(archivePath)}  ${archiveStem}.tar.gz\n`,
      'utf-8',
    );

    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            verifyArtifactsPath,
            '--artifacts-dir',
            artifactsDir,
            '--checksums',
            checksumsPath,
          ],
          {
            cwd: repoRoot,
            env: {
              ...process.env,
              // The contract is an early clean exit, not a scheduler race.
              // Keep enough headroom for this file's parallel archive tests to
              // observe the child close event on a loaded CI worker.
              HAPPIER_RELEASE_SERVER_SMOKE_TIMEOUT_MS: '2000',
            },
            encoding: 'utf-8',
            stdio: 'pipe',
          },
        ),
      /server binary exited before the smoke window/i,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts selects the packaged binary instead of a sibling sidecar directory', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-server-layout-'));
  try {
    const artifactsDir = join(workspace, 'artifacts');
    const stageRoot = join(workspace, 'stage');
    const archivePlatform = normalizeArchivePlatform(process.platform);
    const archiveArch = normalizeArchiveArch(process.arch);
    const archiveStem = `happier-server-v0.0.0-layout-${archivePlatform}-${archiveArch}`;
    const stageDir = join(stageRoot, archiveStem);
    const markerPath = join(workspace, 'selected-binary.txt');
    const archivePath = join(artifactsDir, `${archiveStem}.tar.gz`);
    const checksumsPath = join(artifactsDir, 'checksums-happier-server-v0.0.0-layout.txt');

    await mkdir(join(stageDir, 'generated', 'sqlite-client'), { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(stageDir, 'generated', 'sqlite-client', 'placeholder.txt'), 'placeholder\n', 'utf-8');
    await writeFile(
      join(stageDir, 'happier-server'),
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `printf 'selected-binary\\n' > "${markerPath}"`,
        'exec sleep 30',
        '',
      ].join('\n'),
      { encoding: 'utf-8', mode: 0o755 },
    );

    execFileSync('tar', ['-czf', archivePath, '-C', stageRoot, archiveStem], { cwd: repoRoot });
    await writeFile(
      checksumsPath,
      `${await sha256(archivePath)}  ${archiveStem}.tar.gz\n`,
      'utf-8',
    );

    execFileSync(
      process.execPath,
      [
        verifyArtifactsPath,
        '--artifacts-dir',
        artifactsDir,
        '--checksums',
        checksumsPath,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HAPPIER_RELEASE_SERVER_SMOKE_TIMEOUT_MS: '1000',
        },
        stdio: 'pipe',
      },
    );

    assert.equal(await readFile(markerPath, 'utf-8'), 'selected-binary\n');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts includes stdout in smoke failures when stderr is empty', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-stdout-'));
  try {
    const artifactsDir = join(workspace, 'artifacts');
    const stageRoot = join(workspace, 'stage');
    const archivePlatform = normalizeArchivePlatform(process.platform);
    const archiveArch = normalizeArchiveArch(process.arch);
    const archiveStem = `happier-v0.0.0-test-${archivePlatform}-${archiveArch}`;
    const stageDir = join(stageRoot, archiveStem);
    const archivePath = join(artifactsDir, `${archiveStem}.tar.gz`);
    const checksumsPath = join(artifactsDir, 'checksums-happier-v0.0.0-test.txt');

    await mkdir(stageDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(stageDir, 'happier'),
      '#!/usr/bin/env bash\necho "stdout-only smoke failure"\nexit 1\n',
      { encoding: 'utf-8', mode: 0o755 },
    );

    execFileSync('tar', ['-czf', archivePath, '-C', stageRoot, archiveStem], { cwd: repoRoot });
    await writeFile(
      checksumsPath,
      `${await sha256(archivePath)}  ${archiveStem}.tar.gz\n`,
      'utf-8',
    );

    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            verifyArtifactsPath,
            '--artifacts-dir',
            artifactsDir,
            '--checksums',
            checksumsPath,
          ],
          { cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe' },
        ),
      /stdout-only smoke failure/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts rejects a CLI version mismatch even when optional smoke tests are skipped', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-cli-version-'));
  try {
    const artifactsDir = join(workspace, 'artifacts');
    const stageRoot = join(workspace, 'stage');
    const archivePlatform = normalizeArchivePlatform(process.platform);
    const archiveArch = normalizeArchiveArch(process.arch);
    const expectedVersion = '1.2.3';
    const embeddedVersion = '1.2.3-preview.99';
    const archiveStem = `happier-v${expectedVersion}-${archivePlatform}-${archiveArch}`;
    const stageDir = join(stageRoot, archiveStem);
    const archivePath = join(artifactsDir, `${archiveStem}.tar.gz`);
    const checksumsPath = join(artifactsDir, `checksums-happier-v${expectedVersion}.txt`);

    await mkdir(stageDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(stageDir, 'happier'),
      `#!/usr/bin/env bash\nprintf '%s\\n' '${embeddedVersion}'\n`,
      { encoding: 'utf-8', mode: 0o755 },
    );

    execFileSync('tar', ['-czf', archivePath, '-C', stageRoot, archiveStem], { cwd: repoRoot });
    await writeFile(
      checksumsPath,
      `${await sha256(archivePath)}  ${archiveStem}.tar.gz\n`,
      'utf-8',
    );

    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            verifyArtifactsPath,
            '--artifacts-dir',
            artifactsDir,
            '--checksums',
            checksumsPath,
            '--skip-smoke',
          ],
          { cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe' },
        ),
      /version mismatch.*expected 1\.2\.3.*got 1\.2\.3-preview\.99/i,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts exercises the isolated runtime payload of a native base CLI', async () => {
  const version = '1.2.3';
  const fixture = await createComponentFixture({
    product: 'happier',
    files: createBaseCliRuntimeSmokeFixtureFiles(version),
  });
  try {
    const markerPath = join(fixture.workspace, 'runtime-smoke-markers.txt');
    const result = fixture.run(['--skip-smoke'], {
      ...process.env,
      HAPPIER_TEST_RUNTIME_SMOKE_MARKER: markerPath,
      NODE_PATH: join(fixture.workspace, 'outside-node-modules'),
    });
    assert.deepEqual(result.baseCliRuntimeSmokes, [fixture.archiveName]);
    const markers = new Set((await readFile(markerPath, 'utf8')).trim().split('\n'));
    assert.deepEqual(markers, new Set([
      'package-dist-version',
      'claude-query',
      'sdk-mcp-server',
      'mcp-cjs',
      'mcp-ping',
      'mcp-list',
      'mcp-call',
      'sharp',
      'node-pty',
      'rg-version',
      'rg-search',
      ...(process.platform === 'win32' ? [] : ['zellij-version']),
      ...(process.platform === 'linux' ? ['homebridge'] : []),
    ]));
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts rejects a native CLI whose version works but help fails', async () => {
  const fixture = await createComponentFixture({
    product: 'happier',
    files: {
      ...createBaseCliRuntimeSmokeFixtureFiles('1.2.3'),
      happier: `#!/usr/bin/env bash
if [[ "\${1:-}" == '--help' ]]; then
  printf 'native help metadata failure\\n' >&2
  exit 1
fi
printf '1.2.3\\n'
`,
    },
  });
  try {
    assert.throws(() => fixture.run(['--skip-smoke'], {
      ...process.env,
      HAPPIER_TEST_RUNTIME_SMOKE_MARKER: join(fixture.workspace, 'runtime-smoke-markers.txt'),
    }), /native help metadata failure/);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts rejects Claude SDK native fallback packages left in a base CLI projection', async () => {
  const fixture = await createComponentFixture({
    product: 'happier',
    files: {
      ...createBaseCliRuntimeSmokeFixtureFiles('1.2.3'),
      'node_modules/@anthropic-ai/claude-agent-sdk/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/package.json': '{}',
    },
  });
  try {
    assert.throws(
      () => fixture.run(['--skip-smoke'], {
        ...process.env,
        HAPPIER_TEST_RUNTIME_SMOKE_MARKER: join(fixture.workspace, 'runtime-smoke-markers.txt'),
      }),
      /unused Claude SDK native fallback package survived projection/i,
    );
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts rejects Windows PTY inputs left in a native non-Windows base CLI projection', {
  skip: process.platform === 'win32',
}, async () => {
  const fixture = await createComponentFixture({
    product: 'happier',
    files: {
      ...createBaseCliRuntimeSmokeFixtureFiles('1.2.3'),
      'node_modules/node-pty/third_party/conpty/win10-x64/conpty.node': 'unused Windows PTY input',
    },
  });
  try {
    assert.throws(
      () => fixture.run(['--skip-smoke'], {
        ...process.env,
        HAPPIER_TEST_RUNTIME_SMOKE_MARKER: join(fixture.workspace, 'runtime-smoke-markers.txt'),
      }),
      /Windows-only PTY input survived non-Windows projection/i,
    );
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts rejects a CLI that times out before its version can be attested', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-cli-version-timeout-'));
  try {
    const artifactsDir = join(workspace, 'artifacts');
    const stageRoot = join(workspace, 'stage');
    const archivePlatform = normalizeArchivePlatform(process.platform);
    const archiveArch = normalizeArchiveArch(process.arch);
    const version = '1.2.3';
    const archiveStem = `happier-v${version}-${archivePlatform}-${archiveArch}`;
    const stageDir = join(stageRoot, archiveStem);
    const archivePath = join(artifactsDir, `${archiveStem}.tar.gz`);
    const checksumsPath = join(artifactsDir, `checksums-happier-v${version}.txt`);

    await mkdir(stageDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(stageDir, 'happier'),
      [
        '#!/usr/bin/env bash',
        "printf 'version %s\\n' '1.2.3-preview.99'",
        'while true; do sleep 1; done',
        '',
      ].join('\n'),
      { encoding: 'utf-8', mode: 0o755 },
    );

    execFileSync('tar', ['-czf', archivePath, '-C', stageRoot, archiveStem], { cwd: repoRoot });
    await writeFile(
      checksumsPath,
      `${await sha256(archivePath)}  ${archiveStem}.tar.gz\n`,
      'utf-8',
    );

    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            verifyArtifactsPath,
            '--artifacts-dir',
            artifactsDir,
            '--checksums',
            checksumsPath,
            '--skip-smoke',
          ],
          {
            cwd: repoRoot,
            encoding: 'utf-8',
            stdio: 'pipe',
            env: { ...process.env, HAPPIER_RELEASE_BINARY_SMOKE_TIMEOUT_MS: '500' },
          },
        ),
      /smoke test timed out/i,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts hard-times-out packaged server binaries that ignore SIGTERM', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-timeout-'));
  try {
    const artifactsDir = join(workspace, 'artifacts');
    const stageRoot = join(workspace, 'stage');
    const archivePlatform = normalizeArchivePlatform(process.platform);
    const archiveArch = normalizeArchiveArch(process.arch);
    const archiveStem = `happier-server-v0.0.0-timeout-${archivePlatform}-${archiveArch}`;
    const stageDir = join(stageRoot, archiveStem);
    const archivePath = join(artifactsDir, `${archiveStem}.tar.gz`);
    const checksumsPath = join(artifactsDir, 'checksums-happier-server-v0.0.0-timeout.txt');

    await mkdir(stageDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(stageDir, 'happier-server'),
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        "trap '' TERM",
        "printf 'ready\\n'",
        'while true; do sleep 1; done',
        '',
      ].join('\n'),
      { encoding: 'utf-8', mode: 0o755 },
    );

    execFileSync('tar', ['-czf', archivePath, '-C', stageRoot, archiveStem], { cwd: repoRoot });
    await writeFile(
      checksumsPath,
      `${await sha256(archivePath)}  ${archiveStem}.tar.gz\n`,
      'utf-8',
    );

    const startedAt = Date.now();
    execFileSync(
      process.execPath,
      [
        verifyArtifactsPath,
        '--artifacts-dir',
        artifactsDir,
        '--checksums',
        checksumsPath,
      ],
      {
        cwd: repoRoot,
        stdio: 'pipe',
        timeout: 30_000,
      },
    );
    assert.ok(
      Date.now() - startedAt < 28_000,
      'verify-artifacts should stop hung packaged server binaries on its internal smoke timeout',
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
