// @ts-check

/**
 * Re-lays-out the macOS DMG that `tauri build` produced, before notarization.
 *
 * Tauri's DMG step (tauri-bundler bundle_dmg) cannot express two things the
 * installer window needs:
 *   - an icon size: it never passes --icon-size, so icons render at 128pt;
 *   - hiding the volume's dot-files: it parks "every item" off-window, but
 *     Finder's "every item" skips invisible files, so `.background` and
 *     `.VolumeIcon.icns` stay where they land. Anyone who shows hidden files
 *     then sees them on top of the background.
 *
 * This step converts the DMG to read-write, applies the layout from
 * tauri.conf.json (bundle.macOS.dmg) plus the icon/text size below, parks the
 * dot-files outside the window by name, converts back to a compressed image
 * under the same name, and re-signs it when a signing identity is available
 * (Tauri signed the original; any change invalidates that signature). It must
 * run before notarization. See apps/ui/src-tauri/dmg/README.md.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

export const DMG_ICON_SIZE = 88;
export const DMG_TEXT_SIZE = 12;

/** Dot-files a DMG volume can carry; parked outside the window by name. */
export const HIDDEN_VOLUME_ITEMS = Object.freeze(['.background', '.VolumeIcon.icns', '.fseventsd', '.Trashes']);

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function walkFiles(dir) {
  /** @type {string[]} */
  const out = [];
  if (!fs.existsSync(dir)) return out;
  /** @type {string[]} */
  const stack = [dir];
  while (stack.length > 0) {
    const current = /** @type {string} */ (stack.pop());
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        // An .app bundle never contains the DMG; skip its (large) tree.
        if (!entry.name.endsWith('.app')) stack.push(full);
      } else {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * The DMG Tauri wrote: `<target>/…/release/bundle/dmg/*.dmg`.
 *
 * @param {string[]} files
 * @returns {string | null}
 */
export function pickBundledDmg(files) {
  const candidates = files
    .filter((p) => {
      const norm = p.replaceAll(path.sep, '/');
      return norm.includes('/release/bundle/') && norm.toLowerCase().endsWith('.dmg') && !norm.includes('/rw.');
    })
    .sort((a, b) => a.localeCompare(b));
  return candidates[0] ?? null;
}

/**
 * @param {string} value
 */
function appleScriptString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * @param {{
 *   volumeName: string;
 *   appName: string;
 *   windowSize: { width: number; height: number };
 *   appPosition: { x: number; y: number };
 *   applicationFolderPosition: { x: number; y: number };
 *   iconSize: number;
 *   textSize: number;
 *   hiddenItems: ReadonlyArray<string>;
 *   backgroundFileName?: string | null;
 * }} layout
 * @returns {string}
 */
export function buildLayoutAppleScript(layout) {
  const { width, height } = layout.windowSize;
  const parkX = width + 200;
  const hidden = layout.hiddenItems
    .map((name, index) => `      try\n        set position of item ${appleScriptString(name)} of container window to {${parkX}, ${100 + index * 150}}\n      end try`)
    .join('\n');
  return `tell application "Finder"
  tell disk ${appleScriptString(layout.volumeName)}
    open
    tell container window
      set current view to icon view
      set toolbar visible to false
      set statusbar visible to false
      set the bounds to {100, 100, ${100 + width}, ${100 + height}}
    end tell
    set opts to the icon view options of container window
    tell opts
      set arrangement to not arranged
      set icon size to ${layout.iconSize}
      set text size to ${layout.textSize}
    end tell
${layout.backgroundFileName ? `    set background picture of opts to file ${appleScriptString(`.background:${layout.backgroundFileName}`)}\n` : ''}    set position of item ${appleScriptString(layout.appName)} of container window to {${layout.appPosition.x}, ${layout.appPosition.y}}
    set position of item "Applications" of container window to {${layout.applicationFolderPosition.x}, ${layout.applicationFolderPosition.y}}
${hidden}
    close
    open
    update without registering applications
    delay 2
    close
  end tell
end tell
`;
}

/**
 * @param {{ dryRun: boolean }} opts
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ stdio?: any; env?: NodeJS.ProcessEnv }} [extra]
 * @returns {string}
 */
function run(opts, cmd, args, extra = {}) {
  if (opts.dryRun) {
    console.log(`[dry-run] ${cmd} ${args.join(' ')}`);
    return '';
  }
  return String(
    execFileSync(cmd, args, {
      stdio: extra.stdio ?? ['ignore', 'pipe', 'inherit'],
      env: extra.env ?? process.env,
      timeout: 10 * 60_000,
    }) ?? '',
  );
}

/**
 * @param {string} attachOutput
 * @returns {string | null}
 */
export function parseMountPoint(attachOutput) {
  const lines = String(attachOutput).split('\n').filter((l) => l.includes('/Volumes/'));
  const last = lines.at(-1);
  if (!last) return null;
  const idx = last.indexOf('/Volumes/');
  return last.slice(idx).trim();
}

function main() {
  const { values } = parseArgs({
    options: {
      'ui-dir': { type: 'string', default: 'apps/ui' },
      'dry-run': { type: 'boolean', default: false },
      // Finder's `item ".background"` only resolves invisible files while
      // Finder shows them. On a CI runner we flip the preference for the
      // duration of the step; never pass this on a developer's machine.
      'show-hidden-files': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  const opts = { dryRun: values['dry-run'] === true };

  if (process.platform !== 'darwin') fail('relayout-macos-dmg must run on macOS.');

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const uiDir = path.resolve(repoRoot, String(values['ui-dir']));
  const tauriDir = path.join(uiDir, 'src-tauri');
  const config = JSON.parse(fs.readFileSync(path.join(tauriDir, 'tauri.conf.json'), 'utf8'));
  const dmgConfig = config?.bundle?.macOS?.dmg;
  if (!dmgConfig?.windowSize || !dmgConfig?.appPosition || !dmgConfig?.applicationFolderPosition) {
    fail('tauri.conf.json bundle.macOS.dmg must define windowSize, appPosition and applicationFolderPosition.');
  }

  const dmgPath = opts.dryRun ? path.join(tauriDir, 'target', 'release', 'bundle', 'dmg', 'DRY_RUN.dmg') : pickBundledDmg(walkFiles(path.join(tauriDir, 'target')));
  if (!dmgPath) {
    console.log('No bundled DMG found; nothing to re-lay-out.');
    return;
  }
  console.log(`Re-laying-out ${dmgPath}`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-dmg-relayout-'));
  const rwPath = path.join(work, 'rw.dmg');
  const outPath = path.join(work, 'out.dmg');
  let mountPoint = null;
  let hiddenFilesToggled = false;

  try {
    run(opts, 'hdiutil', ['convert', dmgPath, '-format', 'UDRW', '-o', rwPath]);
    const attach = run(opts, 'hdiutil', ['attach', rwPath, '-readwrite', '-noverify', '-noautoopen']);
    mountPoint = opts.dryRun ? '/Volumes/DRY_RUN' : parseMountPoint(attach);
    if (!mountPoint) fail(`Could not find the mount point in hdiutil output:\n${attach}`);
    const volumeName = path.basename(mountPoint);

    const appName = opts.dryRun
      ? 'DRY_RUN.app'
      : fs.readdirSync(mountPoint).find((name) => name.endsWith('.app'));
    if (!appName) fail(`No .app found in ${mountPoint}.`);

    if (values['show-hidden-files']) {
      run(opts, 'defaults', ['write', 'com.apple.finder', 'AppleShowAllFiles', '-bool', 'true']);
      run(opts, 'killall', ['Finder']);
      hiddenFilesToggled = true;
      if (!opts.dryRun) execFileSync('sleep', ['3']);
    }

    const script = buildLayoutAppleScript({
      volumeName,
      appName,
      windowSize: dmgConfig.windowSize,
      appPosition: dmgConfig.appPosition,
      applicationFolderPosition: dmgConfig.applicationFolderPosition,
      iconSize: DMG_ICON_SIZE,
      textSize: DMG_TEXT_SIZE,
      hiddenItems: HIDDEN_VOLUME_ITEMS,
      // Re-apply the background Tauri copied, so the saved layout never
      // depends on Tauri's own Finder pass having succeeded.
      backgroundFileName: opts.dryRun
        ? null
        : (fs.existsSync(path.join(mountPoint, '.background'))
            ? fs.readdirSync(path.join(mountPoint, '.background')).find((n) => /\.(png|jpe?g|gif|tiff?)$/i.test(n)) ?? null
            : null),
    });
    run(opts, 'osascript', ['-e', script], { stdio: ['ignore', 'inherit', 'inherit'] });

    if (!opts.dryRun) {
      // Finder writes .DS_Store asynchronously; wait for it like Tauri does.
      const dsStore = path.join(mountPoint, '.DS_Store');
      for (let i = 0; i < 20 && !fs.existsSync(dsStore); i += 1) execFileSync('sleep', ['1']);
      if (!fs.existsSync(dsStore)) fail('Finder did not write .DS_Store; the layout was not saved.');
      fs.rmSync(path.join(mountPoint, '.fseventsd'), { recursive: true, force: true });
    }
  } finally {
    if (hiddenFilesToggled) {
      try {
        run(opts, 'defaults', ['delete', 'com.apple.finder', 'AppleShowAllFiles']);
        run(opts, 'killall', ['Finder']);
      } catch {}
    }
    if (mountPoint) {
      try {
        run(opts, 'hdiutil', ['detach', mountPoint]);
      } catch {
        run(opts, 'hdiutil', ['detach', mountPoint, '-force']);
      }
    }
  }

  run(opts, 'hdiutil', ['convert', rwPath, '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-o', outPath]);
  if (!opts.dryRun) fs.copyFileSync(outPath, dmgPath);

  const identity = String(process.env.APPLE_SIGNING_IDENTITY ?? '').trim();
  if (identity && identity !== '-') {
    run(opts, 'codesign', ['--force', '--sign', identity, '--timestamp', dmgPath]);
    run(opts, 'codesign', ['--verify', '--strict', '--verbose=2', dmgPath], { stdio: ['ignore', 'inherit', 'inherit'] });
  } else {
    console.log('No APPLE_SIGNING_IDENTITY: DMG left unsigned (Tauri did not sign it either).');
  }

  fs.rmSync(work, { recursive: true, force: true });
  console.log(`DMG re-laid-out: icon size ${DMG_ICON_SIZE}, text size ${DMG_TEXT_SIZE}, hidden items parked.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
