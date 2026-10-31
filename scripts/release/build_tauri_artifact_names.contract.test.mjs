import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('build-tauri workflow names updater assets as happier-ui-desktop-*', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-tauri.yml'), 'utf8');
  assert.match(workflow, /node scripts\/pipeline\/run\.mjs tauri-collect-updater-artifacts/);

  const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'pipeline', 'tauri', 'collect-updater-artifacts.mjs'), 'utf8');
  assert.match(script, /happier-ui-desktop-preview-\$\{platformKey\}/);
  assert.match(script, /happier-ui-desktop-dev-\$\{platformKey\}/);
  assert.match(script, /happier-ui-desktop-\$\{platformKey\}-v\$\{uiVersion\}/);

  assert.doesNotMatch(script, /happier-ui-preview-/);
  assert.doesNotMatch(script, /happier-ui-\$\{platformKey\}-v/);
});

test('concurrent desktop channels keep candidate, finalized, publish, and setup artifacts isolated', () => {
  const { jobs } = parse(fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-tauri.yml'), 'utf8'));
  const step = (job, name) => jobs[job].steps.find((entry) => entry.name === name);
  const render = (value, environment, platform = 'linux-x86_64') => value
    .replaceAll('${{ inputs.environment }}', environment)
    .replaceAll('${{ matrix.platform_key }}', platform);
  const candidate = step('build', 'Upload desktop candidate').with.name;
  const candidateDownload = step('finalize', 'Download desktop candidate').with.name;
  const finalized = step('finalize', 'Upload finalized updater assets').with.name;
  const preparedDownload = step('prepare_assets', 'Download updater assets artifacts').with.pattern;
  const published = step('prepare_assets', 'Upload publish assets artifact').with.name;
  const setup = step('desktop_setup', 'Download the finalized Linux desktop bundle').with.name;
  const summary = step('desktop_setup', 'Upload desktop-setup summary').with.name;
  for (const environment of ['preview', 'production', 'dev']) {
    const other = environment === 'production' ? 'preview' : 'production';
    assert.notEqual(render(candidate, environment), render(candidate, other), 'candidate uploads must not collide');
    assert.equal(render(candidateDownload, environment), render(candidate, environment));
    assert.notEqual(render(finalized, environment), render(finalized, other), 'finalized uploads must not collide');
    const matches = (name) => name.startsWith(render(preparedDownload, environment).replace(/\*$/u, ''));
    assert.equal(matches(render(finalized, environment)), true);
    assert.equal(matches(render(finalized, other)), false, 'asset preparation must not merge another channel');
    assert.equal(render(setup, environment), render(finalized, environment));
    assert.notEqual(render(published, environment), render(published, other), 'publication uploads must not collide');
    assert.notEqual(render(summary, environment), render(summary, other), 'setup diagnostics must not collide');
  }
  for (const job of ['publish_preview', 'publish_dev', 'publish_stable_release']) {
    assert.equal(jobs[job].with.assets_artifact, published, 'publisher must consume its channel upload');
  }
});
