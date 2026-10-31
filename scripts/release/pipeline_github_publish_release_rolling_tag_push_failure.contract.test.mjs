import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function makeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o755 });
}

for (const tagUpdateSucceeds of [true, false]) {
test(`rolling publication requires tag binding before existing release mutation (tag update succeeds: ${tagUpdateSucceeds})`, (t) => {
  const tmp = fs.mkdtempSync(resolve(os.tmpdir(), 'happier-publish-release-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const binDir = resolve(tmp, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const ghLog = resolve(tmp, 'gh.log');
  fs.writeFileSync(ghLog, '', 'utf8');

  const asset = resolve(tmp, 'asset.txt');
  fs.writeFileSync(asset, 'hello\n', 'utf8');

  const gitPath = resolve(binDir, 'git');
  makeExecutable(
    gitPath,
    `#!/bin/sh
set -eu

cmd="$1"
shift || true

case "$cmd" in
  rev-parse)
    # Simulate no local tag ref.
    exit 1
    ;;
  tag)
    exit 0
    ;;
  push)
    # Simulate a tag protection / permission failure.
    exit 1
    ;;
  remote)
    if [ "$1" = "get-url" ] && [ "$2" = "origin" ]; then
      echo "https://github.com/test/test.git"
      exit 0
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
  );

  const ghPath = resolve(binDir, 'gh');
  makeExecutable(
    ghPath,
    `#!/bin/sh
set -eu

echo "gh $*" >> "${ghLog}"

if [ "$1" = "release" ] && [ "$2" = "view" ]; then
  exit ${tagUpdateSucceeds ? 1 : 0}
fi

if [ "$1" = "api" ]; then
  if echo "$*" | grep -q "repos/test/test/git/ref/tags/dev-test"; then
    echo "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    exit 0
  fi
  if echo "$*" | grep -q "repos/test/test/git/refs/tags/dev-test"; then
    exit ${tagUpdateSucceeds ? 0 : 1}
  fi
  if echo "$*" | grep -q "repos/test/test/releases/tags/dev-test --jq .id"; then
    echo "123"
    exit 0
  fi
  if echo "$*" | grep -q "repos/test/test/releases/123 --jq .target_commitish"; then
    echo "0123456789abcdef0123456789abcdef01234567"
    exit 0
  fi
  if echo "$*" | grep -q -- "--jq .assets\[\].id"; then
    echo "321"
  fi
  exit 0
fi

exit 0
`,
  );

  const env = {
    ...process.env,
    GH_REPO: 'test/test',
    GH_TOKEN: 'dummy',
    GITHUB_REPOSITORY: '',
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
  };

  const result = spawnSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'github', 'publish-release.mjs'),
      '--tag',
      'dev-test',
      '--title',
      'Dev Test',
      '--target-sha',
      '0123456789abcdef0123456789abcdef01234567',
      '--prerelease',
      'true',
      '--rolling-tag',
      'true',
      '--generate-notes',
      'false',
      '--notes',
      'Rolling dev build.',
      '--prune-assets',
      'true',
      '--assets',
      asset,
    ],
    {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  const log = fs.readFileSync(ghLog, 'utf8');
  assert.ifError(result.error);
  assert.match(log, /git\/refs\/tags\/dev-test/);
  if (tagUpdateSucceeds) {
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(log, /gh release upload dev-test /);
  } else {
    assert.notEqual(result.status, 0, 'failed tag binding must fail publication');
    assert.doesNotMatch(log, /gh release (?:create|edit|upload)|gh api -X (?:DELETE|PATCH) repos\/test\/test\/releases\//);
  }
});
}
