import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLimaTestEnv, limaGuestExec } from './lima_guest_harness.mjs';

test('Lima fixtures exclude ambient stack, provider, shell, and executable selection', () => {
  const env = createLimaTestEnv({
    PATH: '/real/user/bin',
    HOME: '/real/user',
    HAPPIER_HOME_DIR: '/real/stack/cli',
    HAPPIER_ACTIVE_SERVER_ID: 'live-server',
    HAPPIER_QA_STACK_NAME: 'live-stack',
    WSREPL_QA_VM_HAPPIER_MODE: 'autoupdate',
    CLAUDE_CONFIG_DIR: '/real/claude',
    CODEX_HOME: '/real/codex',
    BASH_ENV: '/real/shell-startup',
    NODE_OPTIONS: '--import=/real/preload.mjs',
    TMPDIR: '/tmp/fixture-parent',
    LANG: 'en_US.UTF-8',
  });
  assert.equal(env.HAPPIER_HOME_DIR, undefined);
  assert.equal(env.HAPPIER_ACTIVE_SERVER_ID, undefined);
  assert.equal(env.HAPPIER_QA_STACK_NAME, undefined);
  assert.equal(env.HOME, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(env.CODEX_HOME, undefined);
  assert.equal(env.BASH_ENV, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.WSREPL_QA_VM_HAPPIER_MODE, undefined);
  assert.ok(!env.PATH.includes('/real/user/bin'));
  assert.equal(env.TMPDIR, '/tmp/fixture-parent');
  assert.equal(env.LANG, 'en_US.UTF-8');
});

test('fake Lima executes guest scripts without a host login shell, preserving explicit guest environment and argv', () => {
  for (const prefix of [[], ['env', 'LIMA_INSTANCE=fixture-vm']]) {
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', limaGuestExec, 'fake-lima',
      ...prefix, 'bash', '-lc',
      'if shopt -q login_shell; then exit 42; fi; printf "%s\\n" "${LIMA_INSTANCE:-}" "$1"',
      'guest', 'argument with spaces',
    ], { env: { PATH: '/usr/bin:/bin', HOME: '/tmp' }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${prefix.length ? 'fixture-vm' : ''}\nargument with spaces\n`);
  }
});

test('fake guest daemon cleanup cannot invoke host process matching', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lima-guest-process-boundary-'));
  const marker = join(root, 'host-pkill-invoked');
  await writeFile(join(root, 'pkill'), '#!/bin/bash\nprintf called > "$HOST_KILL_MARKER"\n', { mode: 0o755 });
  const result = spawnSync('/bin/bash', ['-c', limaGuestExec, 'fake-lima', 'bash', '-lc',
    'pkill -f "package-dist/index.mjs daemon start-sync"; printf done',
  ], { env: { PATH: `${root}:/usr/bin:/bin`, HOME: root, HOST_KILL_MARKER: marker }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'done');
  await assert.rejects(access(marker), { code: 'ENOENT' });
});
