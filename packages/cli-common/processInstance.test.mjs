import assert from 'node:assert/strict';
import test from 'node:test';

import {
  processInstanceFingerprintMatches,
  readProcessInstanceFingerprintSync,
} from './processInstance.mjs';

test('readProcessInstanceFingerprintSync reads the Linux proc start-time field', () => {
  const stat = `123 (node worker) S ${Array.from({ length: 18 }, (_, index) => index + 1).join(' ')} 987654 0 0`;
  assert.equal(
    readProcessInstanceFingerprintSync(123, {
      platform: 'linux',
      readFileSyncImpl: () => stat,
      spawnSyncImpl: () => {
        throw new Error('portable fallback must not run');
      },
    }),
    'linux-proc:987654',
  );
});

test('readProcessInstanceFingerprintSync reads a Windows CIM creation timestamp', () => {
  const calls = [];
  const fingerprint = readProcessInstanceFingerprintSync(456, {
    platform: 'win32',
    spawnSyncImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: '2026-07-23T12:34:56.0000000Z\r\n' };
    },
  });

  assert.equal(fingerprint, 'win32-cim:2026-07-23T12:34:56.0000000Z');
  assert.equal(calls[0].command, 'powershell.exe');
  assert.match(calls[0].args.at(-1), /ProcessId=456/);
  assert.equal(calls[0].options.shell, undefined);
});

test('processInstanceFingerprintMatches fails closed when either observation is unavailable', () => {
  assert.equal(processInstanceFingerprintMatches('linux-proc:1', 'linux-proc:1'), true);
  assert.equal(processInstanceFingerprintMatches('linux-proc:1', null), false);
  assert.equal(processInstanceFingerprintMatches(null, 'linux-proc:1'), false);
});

test('readLinuxProcProcessInstanceFingerprintSync reads /proc only and is unknown (no child process) when unreadable', async () => {
  const { readLinuxProcProcessInstanceFingerprintSync } = await import('./processInstance.mjs');
  const stat = `123 (node (x)) S ${Array.from({ length: 18 }, (_, index) => index + 1).join(' ')} 987654 0 0`;
  assert.equal(readLinuxProcProcessInstanceFingerprintSync(123, { readFileSyncImpl: () => stat }), 'linux-proc:987654');
  assert.equal(readLinuxProcProcessInstanceFingerprintSync(123, { readFileSyncImpl: () => { throw new Error('ENOENT'); } }), null);
  assert.equal(readLinuxProcProcessInstanceFingerprintSync(1, { readFileSyncImpl: () => stat }), null);
});
