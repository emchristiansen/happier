import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  HAPPIER_MIN_MACOS,
  HOMEBREW_FORMULA_MIN_CLI_VERSION,
  renderHappierCaskFromRelease,
  renderHappierFormulaFromRelease,
} from './render-homebrew-packages.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
// Real release metadata (trimmed) from cli-v0.2.12 and ui-desktop-v0.2.12.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/homebrew-release-v0.2.12.json', import.meta.url), 'utf8'));
// 0.2.12 predates the Homebrew-aware CLI, so it renders only past the floor, as a shape fixture.
const renderFixtureFormula = (overrides = {}) => renderHappierFormulaFromRelease({
  release: fixture.cli.release,
  checksumsText: fixture.cli.checksums,
  minimumVersion: '0.2.12',
  ...overrides,
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('the formula fixture and the committed cask are exactly what the generator renders for v0.2.12', () => {
  assert.equal(
    renderFixtureFormula(),
    readFileSync(new URL('./fixtures/homebrew-formula-v0.2.12.rb', import.meta.url), 'utf8'),
  );
  assert.equal(
    renderHappierCaskFromRelease({ release: fixture.desktop.release, checksumsText: fixture.desktop.checksums }),
    readFileSync(`${repoRoot}packaging/homebrew/Casks/happier.rb`, 'utf8'),
  );
});

test('the formula pins each platform payload to its signed-checksum sha256 and real asset URL', () => {
  const formula = renderFixtureFormula();
  assert.match(formula, /version "0\.2\.12"/);
  for (const [target, sha] of [
    ['darwin-arm64', 'e687d32d84af95f6b19a29cf1559f4ebd56b949b3ea0ce76340235039047a576'],
    ['darwin-x64', 'cce41bbcf314b67464dc667bd871ed4f9599da66fa3c6b4292479f9ed0aefd76'],
    ['linux-arm64', 'bfa15e2aa79a6dbd0a714c7e0a6d51be011a43ddde2f4f453d6458b15b430e82'],
    ['linux-x64', '8978265ce7677bd3f0a0f2f734304bb551452c962b7d46f8f34420892a01fa7e'],
  ]) {
    const url = `https://github.com/happier-dev/happier/releases/download/cli-v0.2.12/happier-v0.2.12-${target}.tar.gz`;
    assert.ok(formula.includes(`url "${url}"\n      sha256 "${sha}"`), `missing pinned ${target}`);
  }
  assert.doesNotMatch(formula, /windows/);
  assert.doesNotMatch(formula, /service do/);
});

test('refuses to render when a platform payload has no signed checksum', () => {
  const checksumsText = fixture.cli.checksums.split('\n').filter((line) => !line.includes('linux-arm64')).join('\n');
  assert.throws(
    () => renderFixtureFormula({ checksumsText }),
    /happier-v0\.2\.12-linux-arm64\.tar\.gz.*checksums-happier-v0\.2\.12\.txt/,
  );
});

test('refuses to render when GitHub\'s asset digest disagrees with the signed checksum', () => {
  const release = clone(fixture.desktop.release);
  const dmg = release.assets.find((asset) => asset.name === 'happier-ui-desktop-darwin-x86_64-v0.2.12.dmg');
  dmg.digest = `sha256:${'0'.repeat(64)}`;
  assert.throws(
    () => renderHappierCaskFromRelease({ release, checksumsText: fixture.desktop.checksums }),
    /happier-ui-desktop-darwin-x86_64-v0\.2\.12\.dmg.*digest/,
  );
});

test('refuses a release that is missing a macOS DMG, a draft, or a prerelease', () => {
  const missing = clone(fixture.desktop.release);
  missing.assets = missing.assets.filter((asset) => !asset.name.endsWith('darwin-aarch64-v0.2.12.dmg'));
  assert.throws(
    () => renderHappierCaskFromRelease({ release: missing, checksumsText: fixture.desktop.checksums }),
    /happier-ui-desktop-darwin-aarch64-v0\.2\.12\.dmg/,
  );
  for (const flag of ['draft', 'prerelease']) {
    const release = { ...clone(fixture.cli.release), [flag]: true };
    assert.throws(
      () => renderFixtureFormula({ release }),
      /stable/,
    );
  }
});

test('the cask derives per-arch DMG URLs that match the published assets', () => {
  const cask = renderHappierCaskFromRelease({ release: fixture.desktop.release, checksumsText: fixture.desktop.checksums });
  assert.match(cask, /sha256 arm: {3}"b9536e3244b30c891b4310bdcf892738682a84ad3f1afee00b9e64a9146eb509",\n {9}intel: "cc85a7d049a0d52fcd11d310d65310349a8535477789021303ea034a110451a9"/);
  assert.match(cask, /url "https:\/\/github\.com\/happier-dev\/happier\/releases\/download\/ui-desktop-v#\{version\}\/happier-ui-desktop-darwin-#\{arch\}-v#\{version\}\.dmg"/);
  assert.match(cask, /auto_updates true/);
});

test('the cask and the formula declare the same macOS minimum, which is the desktop app\'s declared one', () => {
  // The app installs the CLI, whose Bun binary requires macOS 13, so both share one floor.
  assert.deepEqual(HAPPIER_MIN_MACOS, { symbol: 'ventura', version: '13.0' });
  const tauriConfig = JSON.parse(readFileSync(`${repoRoot}apps/ui/src-tauri/tauri.conf.json`, 'utf8'));
  assert.equal(tauriConfig.bundle.macOS.minimumSystemVersion, HAPPIER_MIN_MACOS.version);
  const cask = renderHappierCaskFromRelease({ release: fixture.desktop.release, checksumsText: fixture.desktop.checksums });
  assert.match(cask, new RegExp(`\n  depends_on macos: :${HAPPIER_MIN_MACOS.symbol}\n`));
  assert.doesNotMatch(cask, /depends_on :macos/);
  assert.match(renderFixtureFormula(), new RegExp(`    depends_on macos: :${HAPPIER_MIN_MACOS.symbol}\n`));
});

test('refuses a CLI release older than the first Homebrew-aware one (its self update and service would not defer to Homebrew)', () => {
  assert.equal(HOMEBREW_FORMULA_MIN_CLI_VERSION, '0.2.13');
  assert.throws(
    () => renderHappierFormulaFromRelease({ release: fixture.cli.release, checksumsText: fixture.cli.checksums }),
    /cli-v0\.2\.12.*0\.2\.13/,
  );
});

test('the formula requires the macOS release the CLI binary is built for, on macOS only', () => {
  // The shipped darwin arm64/x64 `happier` binaries declare LC_BUILD_VERSION minos 13.0 (Bun).
  const formula = renderFixtureFormula();
  assert.match(formula, /  on_macos do\n    depends_on macos: :ventura\n\n    on_arm do/);
  assert.doesNotMatch(formula.split('  on_linux do')[1], /depends_on/);
});


for (const [kind, versionFlag, outputPath, render] of [
  ['cli', '--cli-version', 'Formula/happier.rb', (text) => assert.match(text, /class Happier < Formula/)],
  ['desktop', '--desktop-version', 'Casks/happier.rb', (text) => assert.match(text, /cask "happier"/)],
]) {
  for (const primaryPresent of [true, false]) {
    test(`the ${kind} command selects its exact checksum envelope with component assets first (primary present: ${primaryPresent})`, () => {
      const directory = mkdtempSync(join(tmpdir(), 'happier-homebrew-fetch-'));
      try {
        const source = JSON.parse(JSON.stringify(fixture[kind]).replaceAll('0.2.12', '0.2.17'));
        const primary = source.release.assets.find((asset) => asset.name.startsWith('checksums-'));
        assert.ok(primary);
        const component = {
          name: 'checksums-happier-memory-runtime-v0.2.17.txt',
          browser_download_url: 'https://release.example/component-checksums.txt',
        };
        source.release.assets.unshift(component);
        if (!primaryPresent) source.release.assets = source.release.assets.filter((asset) => asset !== primary);
        const requestsPath = join(directory, 'requests.jsonl');
        const preloadPath = join(directory, 'http-fixture.mjs');
        // Only HTTP is replaced; execute the real command, selection, renderer and file writes.
        writeFileSync(preloadPath, `
          import { appendFileSync } from 'node:fs';
          const source = ${JSON.stringify(source)};
          const requestsPath = ${JSON.stringify(requestsPath)};
          globalThis.fetch = async (url, options) => {
            appendFileSync(requestsPath, JSON.stringify({ url, headers: options.headers }) + '\\n');
            if (url === ${JSON.stringify(`https://api.github.com/repos/happier-dev/happier/releases/tags/${source.release.tag_name}`)}) {
              return new Response(JSON.stringify(source.release), { status: 200 });
            }
            if (url === ${JSON.stringify(primary.browser_download_url)}) return new Response(source.checksums);
            if (url === ${JSON.stringify(component.browser_download_url)}) return new Response('0'.repeat(64) + '  component.tar.gz\\n');
            throw new Error('Unexpected fixture HTTP request: ' + url);
          };
        `);
        const result = spawnSync(process.execPath, [
          '--import', preloadPath,
          fileURLToPath(new URL('./render-homebrew-packages.mjs', import.meta.url)),
          versionFlag, '0.2.17', '--out-dir', join(directory, 'output'),
        ], { encoding: 'utf8', env: { ...process.env, GITHUB_TOKEN: 'fixture-token', GH_TOKEN: '' } });
        assert.ifError(result.error);
        const requests = readFileSync(requestsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        assert.equal(requests[0].headers.Authorization, 'Bearer fixture-token');
        if (primaryPresent) {
          assert.equal(result.status, 0, result.stderr);
          render(readFileSync(join(directory, 'output', outputPath), 'utf8'));
          assert.deepEqual(requests.map(({ url }) => url), [
            `https://api.github.com/repos/happier-dev/happier/releases/tags/${source.release.tag_name}`,
            primary.browser_download_url,
          ]);
          assert.equal(requests[1].headers.Authorization, undefined);
        } else {
          assert.equal(result.status, 1);
          assert.ok(result.stderr.includes(primary.name), result.stderr);
          assert.equal(requests.length, 1, 'refuse missing primary before downloading an unrelated envelope');
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}
