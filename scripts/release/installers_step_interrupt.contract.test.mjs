import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

async function waitForChildPid(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const value = Number(await readFile(path, 'utf8'));
      if (value > 0) return value;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(20);
  }
  throw new Error('The external step process did not become ready.');
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

for (const owner of ['run_installer_step', 'capture_installer_step_output']) {
  test(`${owner} cancels the external descendant that ignores inherited SIGINT`, { skip: process.platform === 'win32' }, async () => {
    const source = await readFile(join(root, 'scripts/release/installers/install.sh'), 'utf8');
    const functions = [...source.matchAll(/^[a-z_]+\(\) \{[\s\S]*?^\}/gm)].map(match => match[0]).join('\n');
    const scratch = await mkdtemp(join(tmpdir(), 'happier-installer-interrupt-'));
    const ready = join(scratch, 'child.pid');
    const child = join(scratch, 'child.sh');
    // Genuine process boundary: macOS curl preserves a background shell's ignored SIGINT.
    // This process preserves that disposition and stays alive until the owner cancels it.
    await writeFile(child, '#!/bin/sh\ntrap "" INT\nprintf "%s" "$$" > "$1"\nexec sleep 30\n');
    const invocation = owner === 'run_installer_step'
      ? 'run_installer_step Download step'
      : 'value=""; capture_installer_step_output Metadata value step';
    const script = `set -euo pipefail\n${functions}\nCOLOR_RESET= COLOR_GREEN= COLOR_RED= COLOR_GOLD= COLOR_DIM=\nINSTALLER_SPINNER_FRAMES=(x y)\nTMP_DIR=${shellQuote(scratch)}\nHAPPIER_NO_ANIMATION=1\nstep() { /bin/sh ${shellQuote(child)} ${shellQuote(ready)}; }\n${invocation}\n`;
    const installer = spawn('/bin/bash', ['-c', script], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    installer.stdout.on('data', chunk => { output += chunk; });
    installer.stderr.on('data', chunk => { output += chunk; });
    const completed = new Promise((resolveExit, reject) => {
      installer.once('error', reject);
      installer.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
    let childPid;
    try {
      childPid = await waitForChildPid(ready);
      process.kill(-installer.pid, 'SIGINT');
      const result = await completed;
      assert.equal(result.code, 130, output);
      for (let attempt = 0; attempt < 50 && processIsAlive(childPid); attempt += 1) await delay(20);
      assert.equal(processIsAlive(childPid), false, 'Ctrl-C must stop the external step descendant');
    } finally {
      if (childPid && processIsAlive(childPid)) process.kill(childPid, 'SIGTERM');
      if (processIsAlive(installer.pid)) process.kill(installer.pid, 'SIGTERM');
      await rm(scratch, { recursive: true, force: true });
    }
  });
}
