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
