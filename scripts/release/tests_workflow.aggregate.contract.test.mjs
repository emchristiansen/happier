import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import YAML from 'yaml';
import { resolveVitestShardRange } from '../../apps/cli/scripts/runVitestShards.mjs';

import {
  resolveVitestShardCount,
  resolveVitestShardRange,
  runCliVitestShardRuns,
} from '../../apps/cli/scripts/runVitestShards.mjs';

function jobIds(raw) {
  const jobs = raw.slice(raw.indexOf('\njobs:'));
  return [...jobs.matchAll(/^  ([A-Za-z0-9_-]+):$/gm)].map((m) => m[1]).filter((id) => id !== 'ci_summary');
}

test('tests workflow summary covers every top-level CI lane', async () => {
  const raw = await readFile(join(process.cwd(), '.github/workflows/tests.yml'), 'utf8');
  const summary = raw.match(/\n  ci_summary:[\s\S]*?\n  [A-Za-z0-9_-]+:/)?.[0] ?? raw.slice(raw.indexOf('\n  ci_summary:'));
  const needs = summary.match(/needs: \[([^\]]+)\]/)?.[1]?.split(',').map((id) => id.trim()).filter(Boolean) ?? [];
  assert.ok(needs.length > 0, 'ci_summary must declare its lane dependencies');
  assert.deepEqual(new Set(needs), new Set(jobIds(raw)), 'ci_summary.needs must stay synchronized with every top-level CI lane');
  assert.match(raw, /result !== 'success' && result !== 'skipped'/, 'collector must fail closed for every non-success lane result');
  assert.doesNotMatch(raw, /\["failure","cancelled"\]\.includes\(v\.result\)/, 'collector must not ignore timeout/startup/stale conclusions');
  assert.match(raw, /ci-summary\.json/, 'collector must write a machine-readable summary artifact');
  assert.match(
    summary,
    /CI_SOURCE_SHA:\s*\$\{\{ inputs\.checkout_sha != '' && inputs\.checkout_sha \|\| github\.sha \}\}/,
    'the summary must bind the exact requested checkout rather than the reusable caller SHA',
  );
  assert.match(raw, /name: Upload machine-readable CI summary[\s\S]*?if: always\(\)/, 'summary artifact must upload even when a lane fails');
});

test('selected owner jobs collect every independent diagnostic before failing', async () => {
  const raw = await readFile(join(process.cwd(), '.github/workflows/tests.yml'), 'utf8');
  const workflow = YAML.parse(raw);

  const expectedChecks = {
    cli: ['unit-tests', 'import-cycles', 'cli-common-dist', 'integration-tests', 'slow-tests'],
    'release-contracts': ['release-contracts', 'release-sync-installers'],
    typecheck: [
      'wiring-self',
      'policy-self',
      'wiring-validator',
      'inventory',
      'migration-inventory',
      'workspace-typecheck',
    ],
  };

  for (const [jobId, expectedIds] of Object.entries(expectedChecks)) {
    const steps = workflow.jobs[jobId].steps;
    const outcomeSteps = steps.filter((step) => expectedIds.includes(step.id));
    assert.deepEqual(
      outcomeSteps.map((step) => step.id),
      expectedIds,
      `${jobId} must expose each independent diagnostic as its own outcome-bearing step`,
    );
    for (const step of outcomeSteps) {
      assert.equal(step['continue-on-error'], true, `${jobId}.${step.id} must not hide reachable sibling failures`);
    }
    for (const step of outcomeSteps.slice(1)) {
      assert.match(String(step.if), /!cancelled\(\)/, `${jobId}.${step.id} must run after a sibling failure`);
    }

    const assertion = steps.at(-1);
    assert.equal(String(assertion.if), 'always()', `${jobId} must end with an always-run owner assertion`);
    for (const expectedId of expectedIds) {
      assert.ok(
        Object.values(assertion.env ?? {}).includes(`\${{ steps.${expectedId}.outcome }}`),
        `${jobId} final assertion must consume ${expectedId}.outcome`,
      );
    }
  }
});

test('CLI and Release Contracts restore the existing Yarn cache without saving it', async () => {
  const raw = await readFile(join(process.cwd(), '.github/workflows/tests.yml'), 'utf8');
  const workflow = YAML.parse(raw);
  for (const jobId of ['cli', 'release-contracts']) {
    const steps = workflow.jobs[jobId].steps;
    const setupSteps = steps.filter((step) => String(step.uses ?? '').startsWith('actions/setup-node@'));
    for (const setup of setupSteps) {
      assert.equal(setup.with.cache, undefined, `${jobId} must disable setup-node package-cache save`);
      assert.equal(setup.with['cache-dependency-path'], undefined);
    }
    const resolve = steps.find((step) => step.id === 'yarn-cache-inputs');
    const restores = steps.filter((step) => String(step.uses ?? '').startsWith('actions/cache/restore@'));
    assert.equal(restores.length, 1);
    const restore = restores[0];
    assert.equal(restore.uses, 'actions/cache/restore@5a3ec84eff668545956fd18022155c47e93e2684');
    assert.equal(resolve.shell, 'bash');
    assert.equal(resolve.env.YARN_LOCK_HASH, "${{ hashFiles('yarn.lock') }}");
    assert.deepEqual(restore.with, {
      path: '${{ steps.yarn-cache-inputs.outputs.path }}',
      key: 'node-cache-${{ runner.os }}-${{ steps.yarn-cache-inputs.outputs.arch }}-yarn-${{ steps.yarn-cache-inputs.outputs.lock-hash }}',
      'fail-on-cache-miss': false,
    });
    assert.equal(resolve['continue-on-error'], undefined);
    assert.equal(restore['continue-on-error'], undefined);
    assert.ok(steps.indexOf(resolve) > steps.indexOf(setupSteps.at(-1)));
    assert.ok(steps.indexOf(restore) > steps.indexOf(resolve));
    const corepackIndex = steps.findIndex((step) => step.uses === './.github/actions/enable-corepack-yarn');
    assert.ok(steps.indexOf(restore) < corepackIndex, 'resolve the same pre-Corepack Yarn cache as setup-node');
    const install = steps.find((step) => step.uses === './.github/actions/install-yarn-dependencies');
    assert.ok(steps.indexOf(install) > corepackIndex);
    assert.equal(install.if, undefined, 'a restore hit must not skip dependency installation');
    assert.equal(install.with.args, '--frozen-lockfile --ignore-engines');
    assert.equal(steps.some((step) => /^actions\/cache(?:@|\/save@)/.test(String(step.uses ?? ''))), false);
    assert.equal(resolve.if, jobId === 'cli' ? "env.ACT != 'true'" : undefined);
    assert.equal(restore.if, jobId === 'cli' ? "env.ACT != 'true'" : undefined);
  }
});

test('CLI source checks retain trusted admission after a failed build and artifact consumers require a download', async () => {
  const workflow = YAML.parse(await readFile(join(process.cwd(), '.github/workflows/tests.yml'), 'utf8'));
  const job = workflow.jobs.cli;
  assert.match(job.if, /always\(\)/, 'a failed build must not suppress source checks');
  assert.match(job.if, /!cancelled\(\)/);
  assert.match(job.if, /needs\.ci_plan\.result == 'success'/);
  assert.match(job.if, /needs\.trusted_ref_guard\.result == 'success'/);
  assert.match(job.if, /inputs\.select_jobs_explicitly && inputs\.run_cli/);
  assert.match(job.if, /needs\.ci_plan\.outputs\.run_cli == 'true'/);
  const downloadIndex = job.steps.findIndex((step) => step.id === 'cli-build');
  assert.ok(downloadIndex > job.steps.findIndex((step) => step.id === 'import-cycles'));
  assert.match(job.steps[downloadIndex].if, /needs\.build-cli\.result == 'success'/);
  assert.equal(job.steps[downloadIndex]['continue-on-error'], true);
  for (const id of ['cli-common-dist', 'integration-tests', 'slow-tests']) {
    assert.match(job.steps.find((step) => step.id === id).if, /steps\.cli-build\.outcome == 'success'/);
  }
  const unit = job.steps.find((step) => step.id === 'unit-tests');
  const guard = job.steps.find((step) => step.id === 'import-cycles');
  assert.match(unit.run, /test:unit:vitest/);
  assert.doesNotMatch(unit.run, /test:unit(?:\s|$)/);
  assert.match(guard.run, /test:import-cycles/);
  assert.match(guard.if, /matrix\.part == 1 && !cancelled\(\)/);
  assert.equal(job.strategy['fail-fast'], false);
});

test('CLI result assertion reports all source failures and accepts unavailable artifact lanes only after an upstream failure', async () => {
  const workflow = YAML.parse(await readFile(join(process.cwd(), '.github/workflows/tests.yml'), 'utf8'));
  const assertion = workflow.jobs.cli.steps.at(-1);
  const baseEnv = {
    ...process.env,
    CLI_PART: '1',
    CLI_BUILD_RESULT: 'success',
    CLI_BUILD_OUTCOME: 'success',
    UNIT_TESTS_OUTCOME: 'success',
    IMPORT_CYCLES_OUTCOME: 'success',
    CLI_COMMON_DIST_OUTCOME: 'success',
    INTEGRATION_TESTS_OUTCOME: 'success',
    SLOW_TESTS_OUTCOME: 'success',
  };
  for (const [overrides, expected] of [
    [{}, 0],
    [{ CLI_BUILD_RESULT: 'failure', CLI_BUILD_OUTCOME: 'skipped', CLI_COMMON_DIST_OUTCOME: 'skipped', INTEGRATION_TESTS_OUTCOME: 'skipped', SLOW_TESTS_OUTCOME: 'skipped' }, 0],
    [{ CLI_BUILD_OUTCOME: 'failure', CLI_COMMON_DIST_OUTCOME: 'skipped', INTEGRATION_TESTS_OUTCOME: 'skipped', SLOW_TESTS_OUTCOME: 'skipped' }, 1],
    [{ UNIT_TESTS_OUTCOME: 'failure', IMPORT_CYCLES_OUTCOME: 'failure' }, 1],
    [{ IMPORT_CYCLES_OUTCOME: 'failure' }, 1],
    [{ INTEGRATION_TESTS_OUTCOME: 'failure' }, 1],
    [{ SLOW_TESTS_OUTCOME: 'failure' }, 1],
    [{ SLOW_TESTS_OUTCOME: 'skipped' }, 1],
    [{ CLI_PART: '2', IMPORT_CYCLES_OUTCOME: 'skipped', CLI_COMMON_DIST_OUTCOME: 'skipped', INTEGRATION_TESTS_OUTCOME: 'skipped', SLOW_TESTS_OUTCOME: 'skipped' }, 0],
  ]) {
    const result = spawnSync('bash', ['-e', '-c', assertion.run], { env: { ...baseEnv, ...overrides }, encoding: 'utf8' });
    assert.equal(result.status, expected, JSON.stringify({ overrides, stderr: result.stderr }));
  }
});

test('CI summary attributes skipped binary consumers to the failed build while retaining independent failures', async () => {
  const workflow = YAML.parse(await readFile(join(process.cwd(), '.github/workflows/tests.yml'), 'utf8'));
  const collector = workflow.jobs.ci_summary.steps[0].run.match(/<<'NODE'\n([\s\S]*?)\nNODE/)[1];
  const consumers = ['binary-smoke', 'installers-smoke-linux', 'installers-smoke-macos', 'installers-smoke-windows', 'e2e-core', 'e2e-core-slow', 'cli-daemon-e2e'];
  const needs = {
    ci_plan: { result: 'success' },
    trusted_ref_guard: { result: 'success' },
    'build-cli': { result: 'failure' },
    cli: { result: 'failure' },
    ...Object.fromEntries(consumers.map((id) => [id, { result: 'skipped' }])),
  };
  const cwd = await mkdtemp(join(tmpdir(), 'ci-02-summary-'));
  try {
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      input: collector,
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        NEEDS_JSON: JSON.stringify(needs),
        SELECT_JOBS_EXPLICITLY: 'true',
        REQUEST_RUN_CLI: 'true',
        REQUEST_RUN_BINARY_SMOKE: 'true',
        REQUEST_RUN_INSTALLERS_SMOKE: 'true',
        REQUEST_RUN_E2E_CORE: 'true',
        REQUEST_RUN_E2E_CORE_SLOW: 'true',
        REQUEST_RUN_CLI_DAEMON_E2E: 'true',
      },
    });
    assert.equal(result.status, 1, result.stderr);
    const summary = JSON.parse(await readFile(join(cwd, 'ci-summary.json'), 'utf8'));
    assert.ok(summary.failures.some((lane) => lane.id === 'build-cli' && lane.result === 'failure'));
    assert.ok(summary.failures.some((lane) => lane.id === 'cli' && lane.result === 'failure'));
    for (const id of consumers) {
      assert.equal(summary.failures.find((lane) => lane.id === id).reason, 'blocked by build-cli (failure)');
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('CLI integration covers every shard despite the unit-job partition', async () => {
  const workflow = YAML.parse(await readFile(join(process.cwd(), '.github/workflows/tests.yml'), 'utf8'));
  const job = workflow.jobs.cli;
  const integration = job.steps.find((step) => step.name === 'Run integration tests');
  assert.ok(integration, 'CLI integration must remain scheduled');
  // A single-part integration step must not inherit the two-part unit partition.
  const selectedParts = String(integration.if).includes('matrix.part == 1') ? [1] : job.strategy.matrix.part;
  const covered = new Set();
  for (const part of selectedParts) {
    const range = resolveVitestShardRange({ ...job.env, HAPPIER_CLI_VITEST_PART: String(part), ...integration.env }, 8);
    for (let shard = range.start; shard <= range.end; shard += 1) covered.add(shard);
  }
  assert.deepEqual([...covered].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
});
