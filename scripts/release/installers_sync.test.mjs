import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { syncInstallers } from '../pipeline/release/sync-installers.mjs';
import {
  INSTALLER_PUBLISH_SPECS,
  applyInstallerPublishTransform,
  resolvePublishedInstallerAsset,
} from '../pipeline/release/installers/catalog.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function publishedTargets() {
  return INSTALLER_PUBLISH_SPECS.flatMap((spec) => spec.targets);
}

function sourceFiles() {
  return Array.from(new Set(INSTALLER_PUBLISH_SPECS.map((spec) => spec.source)));
}

function fixtureForSource(name) {
  if (name.endsWith('.sh')) {
    return [
      `fixture:${name}`,
      'CHANNEL="${HAPPIER_CHANNEL:-stable}"',
      '',
    ].join('\n');
  }
  if (name.endsWith('.ps1')) {
    return [
      `fixture:${name}`,
      'param(',
      '  [string] $Channel = $(if ($env:HAPPIER_CHANNEL) { $env:HAPPIER_CHANNEL } else { "stable" }),',
      '  [switch] $SetupRelay',
      ')',
      'if ($Channel -eq "stable") { return "1" }',
      '',
    ].join('\n');
  }
  return `fixture:${name}\n`;
}

function expectedFixtureForTarget(target) {
  for (const spec of INSTALLER_PUBLISH_SPECS) {
    if (spec.targets.includes(target)) {
      return applyInstallerPublishTransform(Buffer.from(fixtureForSource(spec.source), 'utf8'), spec.transform).toString('utf8');
    }
  }
  throw new Error(`unknown installer target: ${target}`);
}

test('syncInstallers copies all installer artifacts to website public directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-sync-'));
  const sourceDir = join(root, 'source');
  const targetDir = join(root, 'target');
  await mkdir(sourceDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });

  for (const name of sourceFiles()) {
    await writeFile(join(sourceDir, name), fixtureForSource(name), 'utf8');
  }

  const result = await syncInstallers({
    sourceDir,
    targetDir,
    checkOnly: false,
  });

  assert.equal(result.ok, true);
  const targets = publishedTargets();
  assert.equal(result.changed.length, targets.length);
  for (const name of targets) {
    const actual = await readFile(join(targetDir, name), 'utf8');
    assert.equal(actual, expectedFixtureForTarget(name));
  }
});

test('syncInstallers projects the shared planet into canonical and published installers and checks source drift', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-planet-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = join(root, 'source');
  const targetDir = join(root, 'target');
  await mkdir(sourceDir, { recursive: true });
  for (const name of sourceFiles()) {
    const art = ['install.sh', 'install.ps1'].includes(name)
      ? '# BEGIN GENERATED PLANET\n# stale planet\n# END GENERATED PLANET\n'
      : '';
    await writeFile(join(sourceDir, name), fixtureForSource(name) + art, 'utf8');
  }
  await syncInstallers({ sourceDir, targetDir });
  for (const name of ['install.sh', 'install.ps1']) {
    const canonical = await readFile(join(sourceDir, name), 'utf8');
    assert.doesNotMatch(canonical, /stale planet/, 'canonical installers must use the shared frame projection');
    assert.equal(await readFile(join(targetDir, name), 'utf8'), canonical);
  }
  await syncInstallers({ sourceDir, targetDir, checkOnly: true });
  const sourcePath = join(sourceDir, 'install.sh');
  const cleanSource = await readFile(sourcePath, 'utf8');
  const staleSource = cleanSource.replace(/(# BEGIN GENERATED PLANET\n)[\s\S]*?(# END GENERATED PLANET)/, '$1# stale planet\n$2');
  await writeFile(sourcePath, staleSource);
  await assert.rejects(syncInstallers({ sourceDir, targetDir, checkOnly: true }), /out of sync/);
  assert.equal(await readFile(sourcePath, 'utf8'), staleSource, '--check must never repair source implicitly');
});

test('syncInstallers publishes preview and dev shortcut endpoints', () => {
  const targets = publishedTargets();
  assert.ok(targets.includes('install-preview'), 'expected install-preview to be published');
  assert.ok(targets.includes('install-dev'), 'expected install-dev to be published');
  assert.ok(targets.includes('install-preview.ps1'), 'expected install-preview.ps1 to be published');
  assert.ok(targets.includes('install-dev.ps1'), 'expected install-dev.ps1 to be published');
  assert.ok(!targets.some((target) => target.startsWith('self-host')), 'expected no self-host installer endpoints to be published');
});

test('installer catalog resolves published installer assets by platform and channel', () => {
  assert.deepEqual(resolvePublishedInstallerAsset({ platform: 'linux', channel: 'stable' }), {
    tag: 'cli-stable',
    installer: 'install.sh',
  });
  assert.deepEqual(resolvePublishedInstallerAsset({ platform: 'darwin', channel: 'preview' }), {
    tag: 'cli-preview',
    installer: 'install-preview.sh',
  });
  assert.deepEqual(resolvePublishedInstallerAsset({ platform: 'win32', channel: 'dev' }), {
    tag: 'cli-dev',
    installer: 'install-dev.ps1',
  });
});

test('syncInstallers normalizes target file modes even when contents are already in sync', async () => {
  if (process.platform === 'win32') {
    // Windows doesn't preserve/express POSIX mode bits consistently.
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'happier-installer-mode-'));
  const sourceDir = join(root, 'source');
  const targetDir = join(root, 'target');
  await mkdir(sourceDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });

  for (const file of sourceFiles()) {
    await writeFile(join(sourceDir, file), fixtureForSource(file), 'utf8');
  }
  for (const target of publishedTargets()) {
    await writeFile(join(targetDir, target), expectedFixtureForTarget(target), 'utf8');
  }

  const name = publishedTargets()[0];
  const targetPath = join(targetDir, name);

  // Simulate executable-bit drift in published artifacts.
  await chmod(targetPath, 0o755);

  const before = (await stat(targetPath)).mode & 0o777;
  assert.equal(before, 0o755);

  await syncInstallers({
    sourceDir,
    targetDir,
    checkOnly: false,
  });

  const after = (await stat(targetPath)).mode & 0o777;
  assert.equal(after, 0o644);
});

test('syncInstallers checkOnly mode fails when published file drifts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-check-'));
  const sourceDir = join(root, 'source');
  const targetDir = join(root, 'target');
  await mkdir(sourceDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });

  for (const file of sourceFiles()) {
    await writeFile(join(sourceDir, file), `expected:${file}\n`, 'utf8');
  }
  for (const name of publishedTargets()) {
    await writeFile(join(targetDir, name), `stale:${name}\n`, 'utf8');
  }

  await assert.rejects(
    () => syncInstallers({ sourceDir, targetDir, checkOnly: true }),
    /out of sync/i
  );
});

test('checked-in website installer artifacts stay in sync with canonical installer sources', async () => {
  await assert.doesNotReject(() => syncInstallers({
    sourceDir: join(repoRoot, 'scripts', 'release', 'installers'),
    targetDir: join(repoRoot, 'apps', 'website', 'public'),
    checkOnly: true,
  }));
});
