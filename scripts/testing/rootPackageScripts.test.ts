import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { ROOT_TYPECHECK_COMMANDS, runRootTypecheck } from './runTypecheck.ts';

const rootPackage = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts?: Record<string, string>;
};

for (const [lane, expectedCommands] of Object.entries({
  unit: [
    ['-s', 'test:shared-packages:local'],
    ['workspace', '@happier-dev/app', 'test'],
    ['workspace', '@happier-dev/cli', 'test:unit'],
    ['--cwd', 'apps/server', 'test:unit'],
    ['--cwd', 'apps/stack', 'test:unit'],
  ],
  integration: [
    ['workspace', '@happier-dev/app', 'test:integration'],
    ['workspace', '@happier-dev/cli', 'test:integration'],
    ['--cwd', 'apps/server', 'test:integration'],
    ['--cwd', 'apps/stack', 'test:integration'],
  ],
})) {
  test(`root ${lane} command runs every workspace after failures and exits nonzero`, () => {
    const fixture = mkdtempSync(join(tmpdir(), 'happier-root-tests-'));
    try {
      const log = join(fixture, 'calls.jsonl');
      const yarn = join(fixture, 'yarn.cjs');
      // Mock only the external package-manager process, retaining the real root orchestration.
      writeFileSync(yarn, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.ROOT_TEST_CALLS, JSON.stringify(args) + '\\n');\nprocess.exit(args.includes('apps/stack') ? 0 : 1);\n`, { mode: 0o755 });
      if (process.platform === 'win32') {
        writeFileSync(join(fixture, 'yarn.cmd'), `@"${process.execPath}" "${yarn}" %*\r\n`);
      } else {
        writeFileSync(join(fixture, 'yarn'), readFileSync(yarn), { mode: 0o755 });
      }
      const result = spawnSync(rootPackage.scripts?.[`test:${lane}`] ?? '', {
        shell: true,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${fixture}${delimiter}${process.env.PATH}`, npm_execpath: yarn, ROOT_TEST_CALLS: log },
      });
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)), expectedCommands);
      assert.match(result.stderr, /Root .* test suite failures:/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}

test('root typecheck script delegates workspace ownership to the all-settled runner', () => {
  assert.equal(
    rootPackage.scripts?.['typecheck:inner'],
    'node --experimental-strip-types scripts/testing/runTypecheck.ts',
  );
  assert.equal(
    rootPackage.scripts?.typecheck,
    'node scripts/runWithHeartbeat.mjs --label typecheck -- yarn -s typecheck:inner',
  );
});

test('root typecheck inventory preserves every existing workspace owner', () => {
  assert.deepEqual(ROOT_TYPECHECK_COMMANDS.map((command) => command.args), [
    ['workspace', 'privacy-kit', 'typecheck'],
    ['workspace', '@happier-dev/protocol', 'typecheck'],
    ['workspace', '@happier-dev/transfers', 'typecheck'],
    ['workspace', '@happier-dev/agents', 'typecheck'],
    ['workspace', '@happier-dev/cli-common', 'typecheck'],
    ['workspace', '@happier-dev/connection-supervisor', 'typecheck'],
    ['workspace', '@happier-dev/bootstrap', 'typecheck'],
    ['workspace', '@happier-dev/app', 'typecheck'],
    ['workspace', '@happier-dev/cli', 'typecheck'],
    ['--cwd', 'apps/server', 'typecheck'],
    ['workspace', '@happier-dev/tests', 'typecheck'],
  ]);
});

test('root typecheck attempts later workspaces after failures and reports the complete failure set', async () => {
  const executed: string[] = [];
  let active = 0;
  let maximumActive = 0;

  await assert.rejects(
    runRootTypecheck({
      commands: [
        { id: 'ui', args: ['workspace', '@happier-dev/app', 'typecheck'] },
        { id: 'cli', args: ['workspace', '@happier-dev/cli', 'typecheck'] },
        { id: 'server', args: ['--cwd', 'apps/server', 'typecheck'] },
      ],
      runCommand: async (command) => {
        executed.push(command.id);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolveRun) => setImmediate(resolveRun));
        active -= 1;
        if (command.id !== 'server') throw new Error(`${command.id} failed`);
      },
    }),
    (error: unknown) => {
      assert.match(String(error), /ui: ui failed/u);
      assert.match(String(error), /cli: cli failed/u);
      return true;
    },
  );

  assert.deepEqual(executed, ['ui', 'cli', 'server']);
  assert.equal(maximumActive, 1);
});

test('root import-cycle command delegates to the CLI guard', () => {
  assert.equal(
    rootPackage.scripts?.['test:import-cycles'],
    'yarn workspace @happier-dev/cli test:import-cycles',
  );
});

test('root provider aliases expose Cursor smoke and extended presets', () => {
  assert.equal(
    rootPackage.scripts?.['test:providers:cursor:smoke'],
    'yarn workspace @happier-dev/tests providers:cursor:smoke',
  );
  assert.equal(
    rootPackage.scripts?.['test:providers:cursor:extended'],
    'yarn workspace @happier-dev/tests providers:cursor:extended',
  );
});

test('root policy self-test covers workflow schedule policy', () => {
  assert.match(
    rootPackage.scripts?.['test:policy:self'] ?? '',
    /scripts\/testing\/workflowSchedulePolicy\.test\.ts/,
    'test:policy:self should run workflow schedule policy checks',
  );
});
