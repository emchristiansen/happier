import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, contents, 'utf8');
  fs.chmodSync(filePath, 0o755);
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

test('pipeline npm publish forces NPM_CONFIG_PROVENANCE off locally (overrides publishConfig.provenance)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-provenance-'));
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const fakeNpx = path.join(binDir, 'npx');
  writeExecutable(
    fakeNpx,
    `#!/usr/bin/env bash
set -euo pipefail
case " $* " in
  *" view "*" dist.integrity "*) if [ -f "$NPM_STUB_PUBLISHED" ]; then printf '"%s"\\n' "$NPM_STUB_INTEGRITY"; else echo "npm error code E404" >&2; exit 1; fi; exit 0 ;;
  *" publish "*) touch "$NPM_STUB_PUBLISHED"; echo "PROVENANCE=$NPM_CONFIG_PROVENANCE"; exit 0 ;;
  *" view "*" dist-tags "*) echo '{"next":"1.0.0-preview.1"}'; exit 0 ;;
esac
echo "unexpected npx invocation: $*" >&2
exit 2
`,
  );

  const tarballPath = path.join(tmpDir, 'pkg.tgz');
  writePackageTarball(tmpDir, tarballPath);
  const integrity = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(tarballPath)).digest('base64')}`;
  const stubEnv = { NPM_STUB_INTEGRITY: integrity };

  const script = resolve(repoRoot, 'scripts', 'pipeline', 'npm', 'publish-tarball.mjs');

  const outLocal = execFileSync(
    process.execPath,
    [script, '--channel', 'preview', '--tarball', tarballPath],
    {
      cwd: repoRoot,
      env: { ...process.env, ...stubEnv, NPM_STUB_PUBLISHED: path.join(tmpDir, 'published-local'), CI: '', GITHUB_ACTIONS: '', PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(outLocal, /PROVENANCE=false/);

  const outGithub = execFileSync(
    process.execPath,
    [script, '--channel', 'preview', '--tarball', tarballPath],
    {
      cwd: repoRoot,
      env: { ...process.env, ...stubEnv, NPM_STUB_PUBLISHED: path.join(tmpDir, 'published-ci'), GITHUB_ACTIONS: 'true', PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(outGithub, /PROVENANCE=true/);
});
