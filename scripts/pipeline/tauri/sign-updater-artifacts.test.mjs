import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { signUpdaterArtifacts } from './sign-updater-artifacts.mjs';

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-tauri-sign-'));
  const bundleDir = path.join(root, 'bundle');
  fs.mkdirSync(path.join(bundleDir, 'nested'), { recursive: true });
  const artifacts = [
    path.join(bundleDir, 'happier.AppImage'),
    path.join(bundleDir, 'nested', 'Happier (dev)_0.2.10-266_x64_en-US.msi'),
  ];
  for (const artifact of artifacts) {
    fs.writeFileSync(artifact, 'candidate-bytes');
    fs.writeFileSync(`${artifact}.sig`, 'candidate-placeholder');
  }
  return { root, bundleDir, artifacts };
}

test('signUpdaterArtifacts signs every updater artifact and replaces only its paired signature', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const calls = [];
  const signature = Buffer.alloc(96, 7).toString('base64');
  const env = Object.freeze({
    TAURI_SIGNING_PRIVATE_KEY: 'opaque-key',
    tauri_signing_private_key: 'alternate-case-key',
    TAURI_PRIVATE_KEY: 'legacy-key',
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'opaque-password',
    MINISIGN_PASSPHRASE: 'fallback-password',
    RETAINED_SETTING: 'retained',
  });

  const count = signUpdaterArtifacts({
    uiDir: fixture.root,
    searchDir: fixture.bundleDir,
    tmpRoot: fixture.root,
    env,
    platform: 'linux',
  }, {
    resolveYarnInvocation: () => ({ cmd: 'yarn', prefixArgs: ['exec'] }),
    runSigner: (cmd, args, options) => {
      calls.push({ cmd, args, options });
      // Tauri is the external process boundary; materialization and environment
      // adaptation stay real. Check what a child actually receives, not only
      // the JavaScript env object (undefined values must disappear at spawn).
      return execFileSync(process.execPath, ['-e', `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const args = JSON.parse(process.argv[1]);
        assert.equal(Object.keys(process.env).some((key) =>
          ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_PRIVATE_KEY'].includes(key.toUpperCase())), false);
        assert.equal(process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, 'opaque-password');
        assert.equal(process.env.MINISIGN_PASSPHRASE, 'fallback-password');
        assert.equal(process.env.RETAINED_SETTING, 'retained');
        assert.equal(fs.readFileSync(args[args.indexOf('--private-key-path') + 1], 'utf8'), 'opaque-key');
        process.stdout.write(${JSON.stringify(`Signature: ${signature}\n`)});
      `, JSON.stringify(args)], options);
    },
  });

  assert.equal(count, 2);
  assert.deepEqual(calls.map((call) => call.args.at(-1)).sort(), [...fixture.artifacts].sort());
  for (const call of calls) {
    assert.equal(call.cmd, 'yarn');
    assert.deepEqual(call.args.slice(0, 7), [
      'exec', '--silent', 'tauri', 'signer', 'sign', '--private-key-path', path.join(fixture.root, 'tauri.signing.key'),
    ]);
    assert.deepEqual(call.args.slice(7, 9), ['--password', 'opaque-password']);
    assert.equal(call.options.cwd, fixture.root);
  }
  assert.equal(env.TAURI_SIGNING_PRIVATE_KEY, 'opaque-key');
  assert.equal(env.TAURI_PRIVATE_KEY, 'legacy-key');
  for (const artifact of fixture.artifacts) {
    assert.equal(fs.readFileSync(`${artifact}.sig`, 'utf8'), `${signature}\n`);
    assert.equal(fs.readFileSync(artifact, 'utf8'), 'candidate-bytes');
  }
});

test('signUpdaterArtifacts rejects orphaned signatures before invoking the signer', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.rmSync(fixture.artifacts[0]);
  let invoked = false;

  assert.throws(() => signUpdaterArtifacts({
    uiDir: fixture.root,
    searchDir: fixture.bundleDir,
    tmpRoot: fixture.root,
    env: { TAURI_SIGNING_PRIVATE_KEY: 'opaque-key' },
    platform: 'linux',
  }, {
    resolveYarnInvocation: () => ({ cmd: 'yarn', prefixArgs: [] }),
    runSigner: () => {
      invoked = true;
      return '';
    },
  }), /updater artifact must be a regular file/);
  assert.equal(invoked, false);
});

test('signUpdaterArtifacts signs with the installed Tauri CLI and a throwaway file key', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const uiDir = fileURLToPath(new URL('../../../apps/ui', import.meta.url));
  const require = createRequire(path.join(uiDir, 'package.json'));
  const tauriCli = path.join(path.dirname(require.resolve('@tauri-apps/cli/package.json')), 'tauri.js');
  const keyPath = path.join(fixture.root, 'throwaway.key');
  const password = 'throwaway-signing-test';
  execFileSync(process.execPath, [tauriCli, 'signer', 'generate', '--ci', '--write-keys', keyPath, '--password', password], {
    stdio: 'pipe',
  });

  const count = signUpdaterArtifacts({
    uiDir,
    searchDir: fixture.bundleDir,
    tmpRoot: fixture.root,
    env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: keyPath, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password },
    platform: process.platform,
  });

  assert.equal(count, fixture.artifacts.length);
  for (const artifact of fixture.artifacts) {
    const signature = fs.readFileSync(`${artifact}.sig`, 'utf8').trim();
    assert.match(Buffer.from(signature, 'base64').toString('utf8'), /untrusted comment:/);
    assert.equal(fs.readFileSync(artifact, 'utf8'), 'candidate-bytes');
  }
});

test('signUpdaterArtifacts rejects invalid signer output without replacing the candidate signature', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  assert.throws(() => signUpdaterArtifacts({
    uiDir: fixture.root,
    searchDir: fixture.bundleDir,
    tmpRoot: fixture.root,
    env: { TAURI_SIGNING_PRIVATE_KEY: 'opaque-key' },
    platform: 'linux',
  }, {
    resolveYarnInvocation: () => ({ cmd: 'yarn', prefixArgs: [] }),
    runSigner: () => 'not-a-signature',
  }), /invalid updater signature/);
  assert.equal(fs.readFileSync(`${fixture.artifacts[0]}.sig`, 'utf8'), 'candidate-placeholder');
});
