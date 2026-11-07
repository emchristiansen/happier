// @ts-check

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Temporary adapter for https://github.com/tauri-apps/tauri/pull/15991.
 * The native Node CLI inherits a close-on-exec stdin into actool, poisoning
 * Apple's persistent ibtoold helper. Reopen stdin at the actual tool exec.
 * Remove this adapter and its callers when our pinned CLI includes the upstream
 * captured-command stdin fix, verified with a fresh macOS helper process.
 *
 * @param {{ env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; tempRoot?: string }} [options]
 */
export function createTauriActoolEnvironment(options = {}) {
  const env = { ...(options.env ?? process.env) };
  if ((options.platform ?? process.platform) !== 'darwin') {
    return { env, cleanup() {} };
  }

  // Resolve before prepending our shim; never recursively rediscover ourselves.
  const actool = execFileSync('xcrun', ['--find', 'actool'], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!path.isAbsolute(actool) || !fs.statSync(actool).isFile()) {
    throw new Error('xcrun did not resolve an absolute actool executable');
  }
  fs.accessSync(actool, fs.constants.X_OK);
  const shimDir = fs.mkdtempSync(path.join(options.tempRoot ?? os.tmpdir(), 'happier-actool-'));
  try {
    const quotedActool = `'${actool.replaceAll("'", "'\\''")}'`;
    fs.writeFileSync(path.join(shimDir, 'actool'), `#!/bin/sh\nexec ${quotedActool} "$@" </dev/null\n`, { mode: 0o700 });
  } catch (error) {
    fs.rmSync(shimDir, { recursive: true, force: true });
    throw error;
  }
  console.warn('[tauri] Applying temporary actool stdin compatibility adapter (tauri-apps/tauri#15991).');
  return {
    env: { ...env, PATH: `${shimDir}${path.delimiter}${env.PATH ?? '/usr/bin:/bin'}` },
    cleanup() { fs.rmSync(shimDir, { recursive: true, force: true }); },
  };
}
