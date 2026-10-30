import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('install.ps1 makes the managed home bin directory the canonical PATH target on Windows', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');

  assert.match(
    raw,
    /\$BinDir\s*=\s*Join-Path\s+\$InstallDir\s+"bin"/i,
    'expected install.ps1 to point PATH at the managed install bin directory',
  );
  assert.doesNotMatch(
    raw,
    /Copy-Item\s+-Path\s+\$target\s+-Destination\s+\(Join-Path\s+\$BinDir\s+"happier\.exe"\)\s+-Force/i,
    'expected install.ps1 to avoid maintaining a drifting external happier.exe copy',
  );
  assert.match(
    raw,
    /\$LegacyBinDir\s*=\s*Join-Path\s+\$env:USERPROFILE\s+"\.local\\bin"/i,
    'expected install.ps1 to keep track of the old default global shim directory for migration',
  );
  assert.match(
    raw,
    /Remove-Item\s+-Path\s+\(Join-Path\s+\$LegacyBinDir\s+"happier\.exe"\)/i,
    'expected install.ps1 to remove the old drifting global shim copy during migration',
  );
  assert.doesNotMatch(
    raw,
    /Where-Object\s*\{\s*\$_\s+-and\s+\$_\s+-ne\s+\$LegacyBinDir\s+-and\s+\$_\s+-ne\s+\$BinDir\s*\}/i,
    'expected install.ps1 to preserve the shared legacy bin directory on PATH because tools like uv install there',
  );
});

test('install.ps1 accepts an exact CLI version request through parameter or environment', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');

  assert.match(raw, /\[string\]\s+\$Version\s*=\s*\$\(if\s*\(\$env:HAPPIER_INSTALL_VERSION\)/i);
  assert.match(raw, /Resolve-InstallerRequestedVersionPattern/i);
  assert.match(raw, /\$assetPattern\s*=\s*if[\s\S]*happier-v\$\{resolvedVersionPattern\}-windows-x64/i);
  assert.match(raw, /\$checksumsPattern\s*=\s*Resolve-InstallerRequestedVersionPattern[\s\S]*checksums-happier-v[\s\S]*\.txt/i);
  assert.doesNotMatch(raw, /\$asset\s*=\s*Resolve-InstallerAsset\s+-Release\s+\$release\s+-Pattern\s+'[\^]happier-v\.\*-windows-x64/i);
});

test('install.ps1 resolves rolling payload aliases while binding exact versions to immutable releases', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');

  assert.match(raw, /\$tag\s*=\s*if\s*\(\$Version\)\s*\{\s*"cli-v\$Version"/i);
  assert.match(raw, /\^happier-windows-x64\\\.tar\\\.gz\$/i);
  assert.match(raw, /\$checksumAssetName\s*=\s*"happier-v\$resolvedVersion-windows-x64\.tar\.gz"/i);
});

test('install.ps1 semver-sorts rolling release assets instead of relying on provider enumeration order', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');

  assert.match(raw, /function Get-InstallerAssetVersionSortKey\s*\{/i);
  assert.match(raw, /function Select-NewestInstallerAsset\s*\{/i);
  assert.match(raw, /Get-AssetByPattern[\s\S]*Select-NewestInstallerAsset/i);
  assert.match(raw, /Get-LocalAssetByPattern[\s\S]*Select-NewestInstallerAsset/i);
  assert.doesNotMatch(raw, /Get-AssetByPattern[\s\S]*Select-Object\s+-Last\s+1/i);
  assert.doesNotMatch(raw, /Get-LocalAssetByPattern[\s\S]*Select-Object\s+-Last\s+1/i);
});

test('install.ps1 exposes installer-side rollback without invoking the current happier command', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');

  assert.match(raw, /\[switch\]\s+\$Rollback/i);
  assert.match(raw, /HAPPIER_INSTALLER_ACTION/i);
  assert.match(raw, /function Invoke-InstallerCliRollback\s*\{/i);
  assert.match(raw, /previous\.version/i);
  assert.match(raw, /New-Item\s+-ItemType\s+HardLink[\s\S]*Resolve-CliShimName/i);
  const rollbackDispatchIndex = raw.indexOf('if ($InstallerAction -eq "rollback")');
  const installedCliFastPathIndex = raw.indexOf('if ($Run -and -not $SetupRelay -and ($existing = Resolve-InstalledCliInvoker))');
  assert.ok(rollbackDispatchIndex >= 0, 'expected install.ps1 to dispatch rollback directly');
  assert.ok(installedCliFastPathIndex >= 0, 'expected install.ps1 to keep the installed CLI fast path');
  assert.ok(
    rollbackDispatchIndex < installedCliFastPathIndex,
    'expected rollback to run before any installed CLI fast path can invoke the current happier command',
  );
});


for (const [older, newer] of [
  ['1.0.0-preview.alpha', '1.0.0-preview.alpha.1'],
  ['1.0.0-preview.alpha', '1.0.0-preview.alpha.beta'],
  ['1.0.0-preview.9', '1.0.0-preview.10'],
  ['1.0.0-preview.1', '1.0.0-preview.alpha'],
  ['1.0.0-preview.alpha.1', '1.0.0'],
]) {
  test(`install.ps1 real remote/local selector orders ${older} before ${newer}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-powershell-asset-order-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const command = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
    // Parse the actual installer with PowerShell's own parser; execute only its four selection owners.
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:HAPPIER_TEST_INSTALLER, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$names = @('Get-InstallerAssetVersionSortKey', 'Select-NewestInstallerAsset', 'Get-AssetByPattern', 'Get-LocalAssetByPattern')
$functions = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $node.Name }, $true))
if ($functions.Count -ne 4) { throw 'Expected exactly the four canonical selection owners' }
foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }
$ReleaseAssetsDir = Join-Path $env:HAPPIER_TEST_ROOT 'assets'
New-Item -Path $ReleaseAssetsDir -ItemType Directory | Out-Null
$oldName = 'checksums-happier-v' + $env:HAPPIER_TEST_OLDER + '.txt'
$newName = 'checksums-happier-v' + $env:HAPPIER_TEST_NEWER + '.txt'
foreach ($name in @($oldName, $newName)) { New-Item -Path (Join-Path $ReleaseAssetsDir $name) -ItemType File | Out-Null }
$forward = Get-AssetByPattern -Release ([pscustomobject]@{ assets = @([pscustomobject]@{ name = $oldName }, [pscustomobject]@{ name = $newName }) }) -Pattern '^checksums-happier-v.*\.txt$'
$reverse = Get-AssetByPattern -Release ([pscustomobject]@{ assets = @([pscustomobject]@{ name = $newName }, [pscustomobject]@{ name = $oldName }) }) -Pattern '^checksums-happier-v.*\.txt$'
$local = Get-LocalAssetByPattern -Pattern '^checksums-happier-v.*\.txt$'
$exact = Get-LocalAssetByPattern -Pattern ('^' + [Regex]::Escape($oldName) + '$')
@{ forward = $forward.name; reverse = $reverse.name; local = $local.Name; exact = $exact.Name; runtime = $PSVersionTable.PSVersion.ToString() } | ConvertTo-Json -Compress
`;
    const run = spawnSync(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        XDG_CONFIG_HOME: root,
        XDG_CACHE_HOME: root,
        POWERSHELL_TELEMETRY_OPTOUT: '1',
        HAPPIER_TEST_INSTALLER: join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'),
        HAPPIER_TEST_ROOT: root,
        HAPPIER_TEST_OLDER: older,
        HAPPIER_TEST_NEWER: newer,
      },
    });
    if (run.error?.code === 'ENOENT' && process.platform !== 'win32') {
      t.skip('PowerShell runtime is unavailable; no Windows selector behavior exercised');
      return;
    }
    assert.equal(run.status, 0, `PowerShell selector failed: ${run.error ?? ''}\n${run.stdout}\n${run.stderr}`);
    const actual = JSON.parse(run.stdout.replace(/^\uFEFF/, '').trim());
    const expected = `checksums-happier-v${newer}.txt`;
    assert.deepEqual([actual.forward, actual.reverse, actual.local], [expected, expected, expected]);
    assert.equal(actual.exact, `checksums-happier-v${older}.txt`, 'exact-version filtering remains authoritative');
  });
}
