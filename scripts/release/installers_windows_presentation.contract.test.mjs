import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlanetFrame } from '../../packages/cli-common/planetFrame.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const installerPath = join(resolve(here, '..', '..'), 'scripts', 'release', 'installers', 'install.ps1');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name} {`);
  assert.notEqual(start, -1, `expected ${name} to exist`);
  const next = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test('install.ps1 presents the compact branded header and truthful install stages', async () => {
  const [source, bashSource] = await Promise.all([
    readFile(installerPath, 'utf8'),
    readFile(join(dirname(installerPath), 'install.sh'), 'utf8'),
  ]);
  const header = extractFunction(source, 'Write-InstallerHeader');

  const powershellRowsBlock = header.match(/\$rows\s*=\s*@\(([\s\S]*?)\n\s*\)/)?.[1];
  const bashRowsBlock = bashSource.match(/HAPPIER_INSTALLER_ART_ROWS=\(([\s\S]*?)\n\)/)?.[1];
  assert.ok(powershellRowsBlock, 'expected PowerShell artwork rows');
  assert.ok(bashRowsBlock, 'expected Bash artwork rows');
  // PowerShell 5.1 may decode a downloaded script with a legacy code page, so the
  // generated planet spells every Braille cell as a code point and stays ASCII.
  const planetBlock = header.match(/# BEGIN GENERATED PLANET[\s\S]*?# END GENERATED PLANET/)?.[0] ?? '';
  assert.match(planetBlock, /\[char\]0x28[0-9a-f]{2}/);
  assert.doesNotMatch(planetBlock, /[^\x00-\x7f]/u);
  const powershellRows = [...powershellRowsBlock.matchAll(/^\s*"([^"]*)",?$/gm)]
    .map((match) => match[1].replace(/\$\(\[char\]0x([0-9a-f]{4})\)/gu, (_, code) => String.fromCharCode(parseInt(code, 16))));
  const bashRows = [...bashRowsBlock.matchAll(/^\s*'([^']*)'$/gm)].map((match) => match[1]);
  const expectedRows = createPlanetFrame({ columns: 28 })
    .map((row) => row.map((cell) => cell?.ch ?? ' ').join(''));
  assert.deepEqual(powershellRows, expectedRows);
  assert.deepEqual(powershellRows, bashRows, 'expected PowerShell and Bash installers to share one visual identity');
  assert.match(header, /Happier/);
  assert.match(header, /Download -> Verify -> Install/);
  assert.match(header, /Test-InstallerRichHeaderAvailable/);
  assert.match(header, /Write-Host "Happier"/);
  assert.match(header, /\[1m/);
  assert.ok(powershellRows.every((row) => [...row].length === 28), 'expected labels to start at one fixed column');
  // The legacy console host has no Braille glyphs; only hosts that can draw them get the art.
  assert.match(header, /-not \(Test-InstallerBrailleArtAvailable\)/);
  const braille = extractFunction(source, 'Test-InstallerBrailleArtAvailable');
  assert.match(braille, /\$env:WT_SESSION/);
  assert.match(braille, /\$env:TERM_PROGRAM/);
  assert.doesNotMatch(header, /Dark(?:Red|Blue|Magenta|Cyan|Yellow)/, 'expected readable colors on dark terminals');

  const richOutput = extractFunction(source, 'Test-InstallerRichHeaderAvailable');
  assert.match(richOutput, /\[Console\]::IsOutputRedirected/);
  assert.match(richOutput, /\$env:TERM\s*-eq\s*"dumb"/i);
  assert.match(richOutput, /WindowWidth\s*-ge\s*76/);
  assert.match(richOutput, /WindowHeight/);
  const bashWidthCheck = bashSource.match(/installer_terminal_is_wide\(\)\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(bashWidthCheck, 'expected Bash terminal-width owner');
  assert.match(bashWidthCheck, /\$\{columns\}\"\s*-ge\s*76/);

  const headerIndex = source.lastIndexOf('Write-InstallerHeader');
  const downloadIndex = source.indexOf('Write-InstallerStage -Name "Download"', headerIndex);
  const metadataIndex = source.indexOf('Fetching $tag release metadata', headerIndex);
  const verifyIndex = source.indexOf('Write-InstallerStage -Name "Verify"', downloadIndex);
  const installIndex = source.indexOf('Write-InstallerStage -Name "Install"', verifyIndex);
  assert.ok(headerIndex < downloadIndex && downloadIndex < metadataIndex);
  assert.ok(metadataIndex < verifyIndex && verifyIndex < installIndex);

  const webRequest = extractFunction(source, 'Invoke-InstallerWebRequestWithRetry');
  assert.match(webRequest, /HAPPIER_NO_ANIMATION/);
  assert.match(webRequest, /-not \(Test-InstallerRichHeaderAvailable\)/);
  assert.match(webRequest, /\$ProgressPreference\s*=\s*"SilentlyContinue"/);
  assert.match(webRequest, /finally\s*\{[\s\S]*\$ProgressPreference\s*=\s*\$previousProgressPreference/);
});

test('install.ps1 scopes the welcome marker to the setup child only', async () => {
  const source = await readFile(installerPath, 'utf8');
  const setup = extractFunction(source, 'Invoke-InstallerSetupCommand');

  assert.match(setup, /\$script:InstallerHeaderShown/);
  assert.match(setup, /\$env:HAPPIER_INSTALLER_WELCOME_SHOWN\s*=\s*"1"/);
  assert.match(setup, /finally\s*\{/);
  assert.match(setup, /Remove-Item Env:HAPPIER_INSTALLER_WELCOME_SHOWN/);
  assert.match(setup, /\$env:HAPPIER_INSTALLER_WELCOME_SHOWN\s*=\s*\$previousValue/);

  const postInstall = extractFunction(source, 'Invoke-PostInstallAction');
  assert.match(postInstall, /if\s*\(\$runValue\s*-eq\s*"setup"\)[\s\S]*Invoke-InstallerSetupCommand/);
});
