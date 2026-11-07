import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./run-checks.mjs', import.meta.url));

function runChecks(profile, customChecks = '') {
  const root = mkdtempSync(join(tmpdir(), 'happier-local-checks-'));
  try {
    mkdirSync(join(root, 'scripts/pipeline'), { recursive: true });
    // Real subprocesses stand in for the expensive package-manager and pipeline boundaries.
    const command = `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.22.22'); } else {
  appendFileSync(process.env.CHECK_LOG, JSON.stringify(args) + '\\n');
  if (args[0] === 'test' || args[0] === 'test:integration') process.exitCode = 1;
}`;
    writeFileSync(join(root, 'command.mjs'), command);
    writeFileSync(join(root, 'scripts/pipeline/run.mjs'), command);
    writeFileSync(join(root, 'yarn'), `#!${process.execPath}\n${command}`, { mode: 0o755 });
    writeFileSync(join(root, 'yarn.cmd'), `@"${process.execPath}" "${join(root, 'command.mjs')}" %*\r\n`);
    const log = join(root, 'commands.jsonl');
    writeFileSync(log, '');
    const result = spawnSync(process.execPath, ['--experimental-strip-types', runner, '--profile', profile, '--custom-checks', customChecks, '--install-deps', 'false'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${root}${delimiter}${process.env.PATH}`, CHECK_LOG: log, GITHUB_ACTIONS: '' },
    });
    return { result, commands: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('full local checks attempt every independent lane and report all failures', () => {
  const { result, commands } = runChecks('full');
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(commands.map((args) => args.join(' ')), [
    'test', 'test:integration', 'typecheck', 'test:e2e:ui', '-s test:release:contracts',
    'release-sync-installers --check', 'test:e2e:core:fast', 'test:e2e:core:slow',
    'test:db-contract:docker', 'website:build', 'docs:build', 'smoke-cli',
  ]);
  assert.match(result.stderr, /unit/);
  assert.match(result.stderr, /integration/);
});

test('custom local checks execute one optional lane without baseline suites', () => {
  const { result, commands } = runChecks('custom', 'build_docs');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(commands, [['docs:build']]);
});

test('invalid custom selection launches no commands', () => {
  const { result, commands } = runChecks('custom', 'typecheck,unknown_check');
  assert.equal(result.status, 1);
  assert.deepEqual(commands, []);
});
