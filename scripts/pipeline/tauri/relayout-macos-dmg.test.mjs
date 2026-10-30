import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DMG_ICON_SIZE,
  HIDDEN_VOLUME_ITEMS,
  buildLayoutAppleScript,
  parseMountPoint,
  pickBundledDmg,
} from './relayout-macos-dmg.mjs';

test('pickBundledDmg picks the DMG under release/bundle', () => {
  const files = [
    '/r/apps/ui/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Happier.app.tar.gz',
    '/r/apps/ui/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Happier_0.2.12_aarch64.dmg',
    '/r/apps/ui/src-tauri/target/debug/other.dmg',
  ];
  assert.equal(pickBundledDmg(files), files[1]);
  assert.equal(pickBundledDmg([]), null);
});

test('parseMountPoint reads the last /Volumes path, including spaces', () => {
  const out = '/dev/disk4\tGUID_partition_scheme\t\n/dev/disk4s1\tApple_HFS\t/Volumes/Happier (dev)\n';
  assert.equal(parseMountPoint(out), '/Volumes/Happier (dev)');
  assert.equal(parseMountPoint('nothing mounted'), null);
});

test('buildLayoutAppleScript sets icon size, positions and parks every hidden item by name', () => {
  const script = buildLayoutAppleScript({
    volumeName: 'Happier (dev)',
    appName: 'Happier (dev).app',
    windowSize: { width: 623, height: 602 },
    appPosition: { x: 169, y: 305 },
    applicationFolderPosition: { x: 451, y: 305 },
    iconSize: DMG_ICON_SIZE,
    textSize: 12,
    hiddenItems: HIDDEN_VOLUME_ITEMS,
  });
  assert.match(script, /tell disk "Happier \(dev\)"/);
  assert.match(script, /set icon size to 88/);
  assert.match(script, /set position of item "Happier \(dev\)\.app" of container window to \{169, 305\}/);
  assert.match(script, /set position of item "Applications" of container window to \{451, 305\}/);
  for (const name of HIDDEN_VOLUME_ITEMS) {
    assert.ok(script.includes(`set position of item "${name}" of container window to {823,`), name);
  }
});

for (const scenario of ['missing-app', 'missing-store', 'layout-error', 'success']) {
  test(`public DMG relayout releases its acquired mount after ${scenario}`, async (t) => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { spawnSync } = await import('node:child_process');
    const { pathToFileURL } = await import('node:url');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dmg-relayout-cleanup-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const ui = path.join(directory, 'ui');
    const tauri = path.join(ui, 'src-tauri');
    const bundle = path.join(tauri, 'target/release/bundle/dmg');
    const volume = path.join(directory, 'volume');
    fs.mkdirSync(bundle, { recursive: true });
    fs.mkdirSync(volume);
    if (scenario !== 'missing-app') fs.mkdirSync(path.join(volume, 'Happier.app'));
    if (scenario === 'success') fs.writeFileSync(path.join(volume, '.DS_Store'), 'layout');
    const dmg = path.join(bundle, 'Happier.dmg');
    fs.writeFileSync(dmg, 'original');
    fs.writeFileSync(path.join(tauri, 'tauri.conf.json'), JSON.stringify({ bundle: { macOS: { dmg: {
      windowSize: { width: 623, height: 602 }, appPosition: { x: 169, y: 305 },
      applicationFolderPosition: { x: 451, y: 305 },
    } } } }));
    const log = path.join(directory, 'commands.jsonl');
    fs.writeFileSync(log, '');
    const script = path.resolve(import.meta.dirname, 'relayout-macos-dmg.mjs');
    const childBoundary = `data:text/javascript,${encodeURIComponent(`
      import fs from 'node:fs';
      export function execFileSync(command, args) {
        fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command, args }) + '\\n');
        if (command === 'hdiutil' && args[0] === 'convert') fs.writeFileSync(args.at(-1), 'converted');
        if (command === 'hdiutil' && args[0] === 'attach') return '/dev/disk4\\tApple_HFS\\t/Volumes/Happier fixture\\n';
        if (command === 'osascript' && ${JSON.stringify(scenario)} === 'layout-error') throw new Error('fixture layout failure');
        if (!['hdiutil', 'defaults', 'killall', 'sleep', 'osascript', 'codesign'].includes(command)) throw new Error('Unexpected command: ' + command);
        return '';
      }
    `)}`;
    const fsBoundary = `data:text/javascript,${encodeURIComponent(`
      import fs from 'node:fs';
      const mapped = (p) => typeof p === 'string' && p.startsWith('/Volumes/Happier fixture')
        ? ${JSON.stringify(volume)} + p.slice('/Volumes/Happier fixture'.length) : p;
      export default { ...fs,
        readdirSync: (p, ...args) => fs.readdirSync(mapped(p), ...args),
        existsSync: (p) => fs.existsSync(mapped(p)),
        rmSync: (p, ...args) => fs.rmSync(mapped(p), ...args),
      };
    `)}`;
    const loader = path.join(directory, 'loader.mjs');
    fs.writeFileSync(loader, `export function resolve(specifier, context, next) {
      if (context.parentURL === ${JSON.stringify(pathToFileURL(script).href)}) {
        if (specifier === 'node:child_process') return { url: ${JSON.stringify(childBoundary)}, shortCircuit: true };
        if (specifier === 'node:fs') return { url: ${JSON.stringify(fsBoundary)}, shortCircuit: true };
      }
      return next(specifier, context);
    }`);
    const preload = path.join(directory, 'register.mjs');
    fs.writeFileSync(preload, `import { register } from 'node:module';
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      register(${JSON.stringify(pathToFileURL(loader).href)}, import.meta.url);`);
    const result = spawnSync(process.execPath, ['--import', preload, script, '--ui-dir', ui, '--show-hidden-files'], {
      encoding: 'utf8', env: { ...process.env, APPLE_SIGNING_IDENTITY: 'fixture signing identity', TMPDIR: directory },
    });
    assert.ifError(result.error);
    const commands = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(commands.filter(({ command, args }) => command === 'hdiutil' && args[0] === 'attach').length, 1);
    assert.equal(result.status, scenario === 'success' ? 0 : 1, result.stdout + result.stderr);
    assert.ok(commands.some(({ command, args }) => command === 'hdiutil' && args[0] === 'detach'), 'the known mount must be detached before the process finishes');
    if (scenario !== 'missing-app') {
      assert.ok(commands.some(({ command, args }) => command === 'defaults' && args[0] === 'delete'), 'temporary hidden-files preference must be reset');
    }
    if (scenario === 'success') {
      assert.equal(fs.readFileSync(dmg, 'utf8'), 'converted');
      assert.equal(commands.filter(({ command }) => command === 'codesign').length, 2);
    } else {
      assert.equal(fs.readFileSync(dmg, 'utf8'), 'original');
      assert.equal(commands.filter(({ command }) => command === 'codesign').length, 0);
    }
  });
}
