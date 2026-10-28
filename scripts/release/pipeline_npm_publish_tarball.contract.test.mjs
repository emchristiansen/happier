import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function createTarball(tmpDir) {
  const packageDir = path.join(tmpDir, 'package');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: '@happier/npm-contract-fixture', version: '1.2.3' }),
    'utf8',
  );
  fs.writeFileSync(path.join(packageDir, 'index.js'), 'export {};\n', 'utf8');
  const tarballPath = path.join(tmpDir, 'fixture.tgz');
  execFileSync('tar', ['-czf', tarballPath, '-C', tmpDir, 'package']);
  const integrity = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(tarballPath)).digest('base64')}`;
  return { tarballPath, integrity };
}

function writeNpmStub(tmpDir) {
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const npmPath = path.join(binDir, 'npm');
  fs.writeFileSync(
    npmPath,
    `#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);
const callsPath = process.env.NPM_STUB_CALLS;
const statePath = process.env.NPM_STUB_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
state.calls = (state.calls ?? 0) + 1;
state.history = [...(state.history ?? []), args];
if (callsPath) fs.appendFileSync(callsPath, JSON.stringify(args) + '\\n');
const writeState = () => fs.writeFileSync(statePath, JSON.stringify(state));
const mode = process.env.NPM_STUB_MODE;
const integrity = process.env.NPM_STUB_INTEGRITY;
const packageVersion = '1.2.3';
if (args[0] === 'view' && args[2] === 'dist.integrity') {
  if ((mode === 'absent' || mode === 'ambiguous' || mode.startsWith('publish-')) && state.integrityQueries === 0) {
    state.integrityQueries = 1;
    writeState();
    process.stderr.write('npm ERR! code E404\\n');
    process.exit(1);
  }
  state.integrityQueries = (state.integrityQueries ?? 0) + 1;
  writeState();
  if (mode === 'publish-network-failure') {
    process.stderr.write('npm ERR! code E503\\n');
    process.exit(1);
  }
  if ((mode === 'publish-delayed-visibility' || mode === 'publish-early-tag') && state.integrityQueries <= 11) {
    process.stderr.write('npm ERR! code E404\\n');
    process.exit(1);
  }
  if (mode === 'publish-mismatch') {
    process.stdout.write(JSON.stringify('sha512-mismatch') + '\\n');
    process.exit(0);
  }
  process.stdout.write(JSON.stringify(state.remoteIntegrity ?? integrity) + '\\n');
  process.exit(0);
}
if (args[0] === 'view' && args[2] === 'dist-tags') {
  state.distTagQueries = (state.distTagQueries ?? 0) + 1;
  writeState();
  if (mode === 'publish-tag-network-failure' || (mode === 'publish-tag-not-found' && state.distTagQueries === 1)) {
    process.stderr.write(mode === 'publish-tag-network-failure' ? 'npm ERR! code E503\\n' : 'npm ERR! code E404\\n');
    process.exit(1);
  }
  if (mode === 'publish-delayed-tag' && state.distTagQueries === 1) {
    process.stdout.write(JSON.stringify(state.previousDistTags ?? {}) + '\\n');
    process.exit(0);
  }
  if (mode === 'publish-delayed-visibility' && state.distTagQueries <= 10) {
    process.stdout.write(JSON.stringify(state.previousDistTags ?? {}) + '\\n');
    process.exit(0);
  }
  if (mode === 'stale-tag' && state.distTagAdds > 0 && state.distTagQueries === 2) {
    process.stdout.write(JSON.stringify(state.previousDistTags ?? {}) + '\\n');
    process.exit(0);
  }
  process.stdout.write(JSON.stringify(state.distTags ?? {}) + '\\n');
  process.exit(0);
}
if (args[0] === 'publish') {
  state.publishCalls = (state.publishCalls ?? 0) + 1;
  writeState();
  if (mode.startsWith('publish-')) {
    state.remoteIntegrity = integrity;
    state.previousDistTags = state.distTags ?? {};
    state.distTags = { ...state.previousDistTags, [args[args.indexOf('--tag') + 1]]: packageVersion };
    writeState();
    process.stdout.write('published\\n');
    process.exit(0);
  }
  if (mode === 'ambiguous') {
    state.remoteIntegrity = integrity;
    state.distTags = { ...(state.distTags ?? {}), [args[args.indexOf('--tag') + 1]]: packageVersion };
    writeState();
    process.stderr.write('npm ERR! network timeout after upload\\n');
    process.exit(1);
  }
  state.remoteIntegrity = integrity;
  writeState();
  process.stdout.write('published\\n');
  process.exit(0);
}
if (args[0] === 'dist-tag' && args[1] === 'add') {
  state.distTagAdds = (state.distTagAdds ?? 0) + 1;
  state.previousDistTags = state.distTags ?? {};
  state.distTags = { ...(state.distTags ?? {}), [args[3]]: packageVersion };
  writeState();
  process.stdout.write('tagged\\n');
  process.exit(0);
}
process.stderr.write('unexpected npm invocation: ' + JSON.stringify(args) + '\\n');
process.exit(2);
`,
    { encoding: 'utf8', mode: 0o755 },
  );
  return binDir;
}

function runNpmPublication(tmpDir, mode, initialState, { npmToken = false, cancelOnWait = false } = {}) {
  const { tarballPath, integrity } = createTarball(tmpDir);
  const statePath = path.join(tmpDir, 'state.json');
  const callsPath = path.join(tmpDir, 'npm-calls.jsonl');
  fs.writeFileSync(statePath, JSON.stringify(initialState), 'utf8');
  const binDir = writeNpmStub(tmpDir);
  const clockPath = path.join(tmpDir, 'clock.mjs');
  // Atomics.wait is the external clock boundary; keep the real publisher and npm process path.
  fs.writeFileSync(clockPath, `import fs from 'node:fs';
Atomics.wait = (_array, _index, _value, milliseconds) => {
  const statePath = process.env.NPM_STUB_STATE;
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.waits = [...(state.waits ?? []), milliseconds];
  fs.writeFileSync(statePath, JSON.stringify(state));
  if (process.env.NPM_STUB_CANCEL_ON_WAIT === 'true') process.kill(process.pid, 'SIGTERM');
  return 'timed-out';
};\n`);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    NPM_STUB_MODE: mode,
    NPM_STUB_STATE: statePath,
    NPM_STUB_CALLS: callsPath,
    NPM_STUB_INTEGRITY: integrity,
    NPM_STUB_CANCEL_ON_WAIT: String(cancelOnWait),
    GITHUB_ACTIONS: 'false',
    NODE_AUTH_TOKEN: npmToken ? 'npm-token-for-test' : '',
    NPM_TOKEN: npmToken ? 'npm-token-for-test' : '',
  };
  let error;
  try {
    execFileSync(
      process.execPath,
      [
        '--import', clockPath,
        resolve(repoRoot, 'scripts', 'pipeline', 'npm', 'publish-tarball.mjs'),
        '--channel',
        'preview',
        '--tarball',
        tarballPath,
        '--npm-version',
        '',
      ],
      { cwd: repoRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
    );
  } catch (caught) {
    error = caught;
  }
  return {
    error,
    state: JSON.parse(fs.readFileSync(statePath, 'utf8')),
    calls: fs
      .readFileSync(callsPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}

test('pipeline npm publish script supports dry-run and derives dist-tag from channel', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-publish-'));
  const tarballDir = path.join(tmpDir, 'dist', 'release-assets', 'cli');
  fs.mkdirSync(tarballDir, { recursive: true });
  const tarballPath = path.join(tarballDir, 'happier-cli-v0.0.0-preview.tgz');
  fs.writeFileSync(tarballPath, 'dummy', 'utf8');

  const outLocal = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'npm', 'publish-tarball.mjs'),
      '--channel',
      'preview',
      '--tarball-dir',
      tarballDir,
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, CI: '', GITHUB_ACTIONS: '' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(outLocal, /\[dry-run\] npx -y npm@11\.5\.1 publish /);
  assert.doesNotMatch(outLocal, /--provenance/, 'local default should not force npm provenance');
  assert.match(outLocal, /--access public/);
  assert.match(outLocal, /--tag next/);

  const outGithub = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'npm', 'publish-tarball.mjs'),
      '--channel',
      'preview',
      '--tarball',
      tarballPath,
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, GITHUB_ACTIONS: 'true' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(outGithub, /\[dry-run\] npx -y npm@11\.5\.1 publish /);
  assert.match(outGithub, /--provenance/, 'GitHub Actions default should enable npm provenance');
});

test('pipeline npm publish uses isolated npmrc when NPM_TOKEN is provided', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-publish-token-'));
  const tarballDir = path.join(tmpDir, 'dist', 'release-assets', 'cli');
  fs.mkdirSync(tarballDir, { recursive: true });
  const tarballPath = path.join(tarballDir, 'happier-cli-v0.0.0-preview.tgz');
  fs.writeFileSync(tarballPath, 'dummy', 'utf8');

  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'npm', 'publish-tarball.mjs'),
      '--channel',
      'preview',
      '--tarball',
      tarballPath,
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, NPM_TOKEN: 'npm-token-for-test' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] npm auth: using isolated npmrc/);
  assert.doesNotMatch(out, /npm-token-for-test/, 'script output must never include the npm token');
});

test('pipeline npm publish skips an exact version, repairs its dist-tag, and verifies the repair', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-publish-exact-'));
  const result = runNpmPublication(tmpDir, 'exact', {
    remoteIntegrity: undefined,
    distTags: { next: '1.2.2' },
    integrityQueries: 0,
  }, { npmToken: true });
  assert.equal(result.error, undefined);
  assert.equal(result.state.publishCalls ?? 0, 0, 'exact integrity must skip npm publish');
  assert.equal(result.state.distTagAdds, 1, 'wrong dist-tag must be repaired');
  assert.equal(result.state.distTags.next, '1.2.3');
  assert.ok(result.calls.some((args) => args[0] === 'view' && args[2] === 'dist.integrity'));
  assert.ok(result.calls.some((args) => args[0] === 'dist-tag' && args[1] === 'add'));
});

test('pipeline npm publish tolerates a stale read after an already-applied dist-tag repair', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-publish-stale-tag-'));
  const result = runNpmPublication(tmpDir, 'stale-tag', {
    remoteIntegrity: undefined,
    distTags: { next: '1.2.2' },
    integrityQueries: 0,
  }, { npmToken: true });
  assert.equal(result.error, undefined);
  assert.equal(result.state.publishCalls ?? 0, 0, 'exact integrity must skip npm publish');
  assert.equal(result.state.distTagAdds, 1, 'the dist-tag mutation must not be repeated');
  assert.equal(result.state.distTagQueries, 3, 'read-only verification should retry after one stale response');
  assert.equal(result.state.distTags.next, '1.2.3');
  const distTagReads = result.calls.filter((args) => args[0] === 'view' && args[2] === 'dist-tags');
  assert.equal(distTagReads.every((args) => args.includes('--prefer-online')), true, 'every verification read must bypass stale npm cache data');
});

test('accepted npm publication waits beyond the old attempt budget for exact integrity and tag visibility', () => {
  for (const mode of ['publish-delayed-visibility', 'publish-early-tag']) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-publish-visibility-'));
    const result = runNpmPublication(tmpDir, mode, {
      distTags: { next: '1.2.2' },
      integrityQueries: 0,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.state.publishCalls, 1);
    assert.equal(result.state.distTagAdds ?? 0, 0, 'accepted publication must only reconcile reads');
    assert.ok(result.state.integrityQueries > 11, 'an early correct tag must not bypass hidden integrity');
    assert.ok(result.state.waits.length > 8, 'valid processing must survive the old attempt ceiling');
    assert.ok(result.calls.filter((args) => args[0] === 'view').every((args) => args.includes('--prefer-online')));
  }
});

test('accepted npm publication fails on mismatched integrity or registry failure without another mutation', () => {
  for (const mode of ['publish-mismatch', 'publish-network-failure', 'publish-tag-network-failure']) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-publish-terminal-'));
    const result = runNpmPublication(tmpDir, mode, { distTags: {}, integrityQueries: 0 });
    assert.notEqual(result.error, undefined);
    assert.match(String(result.error?.stderr), mode === 'publish-mismatch' ? /different integrity/ : /E503/);
    assert.equal(result.state.publishCalls, 1);
    assert.equal(result.state.distTagAdds ?? 0, 0);
    assert.equal(result.state.waits?.length ?? 0, 0, 'terminal errors must not be treated as processing');
  }
});

test('accepted npm publication tolerates a hidden tag response and remains natively cancellable', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-publish-tag-hidden-'));
  const visible = runNpmPublication(tmpDir, 'publish-tag-not-found', { distTags: {}, integrityQueries: 0 });
  assert.equal(visible.error, undefined);
  assert.equal(visible.state.publishCalls, 1);
  assert.equal(visible.state.distTagAdds ?? 0, 0);
  const cancelledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-publish-cancel-'));
  const cancelled = runNpmPublication(cancelledDir, 'publish-early-tag', { distTags: {}, integrityQueries: 0 }, { cancelOnWait: true });
  assert.equal(cancelled.error?.signal, 'SIGTERM');
  assert.match(String(cancelled.error?.stdout), /visibility pending/);
  assert.equal(cancelled.state.publishCalls, 1);
  assert.equal(cancelled.state.distTagAdds ?? 0, 0);
});

test('pipeline npm publish refuses an unrepairable existing dist-tag mismatch without mutating it', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-publish-no-repair-'));
  const result = runNpmPublication(tmpDir, 'exact', {
    distTags: { next: '1.2.2' },
    integrityQueries: 0,
  });
  assert.notEqual(result.error, undefined);
  assert.equal(result.state.publishCalls ?? 0, 0);
  assert.equal(result.state.distTagAdds ?? 0, 0);
  assert.match(String(result.error?.stderr), /without a token for a separate dist-tag repair/);
});

test('pipeline npm publish fails closed when the existing version has different integrity', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-publish-mismatch-'));
  const result = runNpmPublication(tmpDir, 'mismatch', {
    remoteIntegrity: 'sha512-mismatch',
    distTags: {},
    integrityQueries: 0,
  });
  assert.notEqual(result.error, undefined);
  assert.equal(result.state.publishCalls ?? 0, 0, 'integrity mismatch must not republish');
  assert.equal(result.state.distTagAdds ?? 0, 0, 'integrity mismatch must not mutate tags');
});

test('pipeline npm publish recovers an ambiguous publish by re-querying exact integrity', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-publish-recover-'));
  const result = runNpmPublication(tmpDir, 'ambiguous', {
    distTags: {},
    integrityQueries: 0,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.state.publishCalls, 1);
  assert.ok(result.state.integrityQueries >= 2, 'ambiguous publish must trigger an integrity re-query');
  assert.equal(result.state.distTagAdds ?? 0, 0, 'recovered publication already wrote its dist-tag');
  assert.ok(result.calls.some((args) => args[0] === 'publish'));
});
