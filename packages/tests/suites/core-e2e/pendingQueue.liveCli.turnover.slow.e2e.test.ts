import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, it } from 'vitest';

import { repoRootDir } from '../../src/testkit/paths';
import { runLoggedCommand } from '../../src/testkit/process/spawnProcess';
import { sanitizeCliTestEnv } from '../../src/testkit/process/cliTestEnv';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveTsxImportHookSpecifier } from '../../src/testkit/process/tsxImportHook';
import { createRunDirs } from '../../src/testkit/runDir';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: live CLI custody across real publisher turnover', () => {
  let server: StartedServer;
  beforeAll(async () => {
    server = await startServerLight({ testDir: run.testDir('live-cli-turnover'), dbProvider: 'sqlite' });
  }, 180_000);
  afterAll(async () => { await server?.stop(); });

  it.each(['ordinary', 'collision', 'absence', 'old-server', 'dismissed-uncertain'])('preserves exact custody across turnover (%s)', async (scenario) => {
    const root = repoRootDir();
    const testDir = run.testDir(`live-cli-turnover-${scenario}`);
    const hook = resolveTsxImportHookSpecifier();
    if (!hook) throw new Error('Real CLI test requires the repository tsx source loader');
    // Run the CLI in its ordinary source runtime, outside Vitest's module evaluator.
    // This child keeps one real ApiSessionClient and controlled provider across reconnect.
    await runLoggedCommand({
      command: process.execPath,
      args: ['--import', hook, resolve(root, 'packages/tests/suites/core-e2e/fixtures/pendingQueueLiveCliTurnoverWorker.ts'),
        server.baseUrl, scenario, testDir, server.dataDir],
      cwd: root,
      env: {
        ...sanitizeCliTestEnv(process.env),
        HAPPIER_HOME_DIR: resolve(testDir, 'cli-home'),
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_PUBLIC_SERVER_URL: server.baseUrl,
        HAPPIER_LOCAL_SERVER_URL: server.baseUrl,
        HAPPIER_PENDING_CUSTODY_OUTCOME_TIMEOUT_MS: '987654321',
        TSX_TSCONFIG_PATH: resolve(root, 'apps/cli/tsconfig.json'),
      },
      stdoutPath: resolve(testDir, 'live-cli.stdout.log'),
      stderrPath: resolve(testDir, 'live-cli.stderr.log'),
      timeoutMs: 90_000,
    });
  }, 120_000);
});
