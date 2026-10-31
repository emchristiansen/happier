import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-npm-provenance-'));
}

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o700 });
}

function writePackageTarball(root, tarballPath) {
  const packageDir = path.join(root, 'package');
  fs.mkdirSync(packageDir);
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    `${JSON.stringify({ name: '@happier-dev/provenance-fixture', version: '1.0.0-preview.1' })}\n`,
    'utf8',
  );
  execFileSync('tar', ['-czf', tarballPath, '-C', root, 'package']);
}

function runPublishTarball({ githubActions }) {
  const dir = makeTempDir();
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const tarballPath = path.join(dir, 'dummy.tgz');
  writePackageTarball(dir, tarballPath);
  const integrity = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(tarballPath)).digest('base64')}`;

  const npxPath = path.join(binDir, 'npx');
  writeExecutable(
    npxPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'case " $* " in',
      '  *" view "*" dist.integrity "*) if [ -f "$NPM_STUB_PUBLISHED" ]; then printf \'"%s"\\n\' "$NPM_STUB_INTEGRITY"; else echo "npm error code E404" >&2; exit 1; fi; exit 0 ;;',
      '  *" publish "*) touch "$NPM_STUB_PUBLISHED"; echo "NPM_CONFIG_PROVENANCE=${NPM_CONFIG_PROVENANCE-}"; echo "GITHUB_ACTIONS=${GITHUB_ACTIONS-}"; exit 0 ;;',
      '  *" view "*" dist-tags "*) echo \'{"next":"1.0.0-preview.1"}\'; exit 0 ;;',
      'esac',
      'echo "unexpected npx invocation: $*" >&2',
      'exit 2',
      '',
    ].join('\n'),
  );

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    // Ensure the script is the one deciding, not the outer environment.
    NPM_CONFIG_PROVENANCE: '',
    GITHUB_ACTIONS: githubActions ? 'true' : '',
    NPM_STUB_INTEGRITY: integrity,
    NPM_STUB_PUBLISHED: path.join(dir, 'published'),
  };

  return execFileSync(
    process.execPath,
    [
      'scripts/pipeline/npm/publish-tarball.mjs',
      '--channel',
      'preview',
      '--tarball',
      tarballPath,
      '--npm-version',
      '11.5.1',
    ],
    { env, encoding: 'utf8' },
  );
}

test('publish-tarball sets NPM_CONFIG_PROVENANCE=false by default locally', () => {
  const stdout = runPublishTarball({ githubActions: false });
  assert.match(stdout, /NPM_CONFIG_PROVENANCE=false/);
});

test('publish-tarball sets NPM_CONFIG_PROVENANCE=true by default in GitHub Actions', () => {
  const stdout = runPublishTarball({ githubActions: true });
  assert.match(stdout, /NPM_CONFIG_PROVENANCE=true/);
});
