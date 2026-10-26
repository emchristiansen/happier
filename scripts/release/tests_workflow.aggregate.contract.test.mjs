import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

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
    cli: ['unit-tests', 'cli-common-dist', 'integration-tests'],
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

test('CLI matrix dispatches all eight integration shards exactly once', async () => {
  const raw = await readFile(join(process.cwd(), '.github/workflows/tests.yml'), 'utf8');
  const workflow = YAML.parse(raw);
  const cli = workflow.jobs.cli;
  const integration = cli.steps.find((step) => step.id === 'integration-tests');
  const common = cli.steps.find((step) => step.id === 'cli-common-dist');

  assert.deepEqual(cli.strategy.matrix.part, [1, 2]);
  assert.equal(cli.env.HAPPIER_CLI_VITEST_PART, '${{ matrix.part }}');
  assert.equal(cli.env.HAPPIER_CLI_VITEST_PARTS, '2');
  assert.equal(String(integration.if), '${{ !cancelled() }}');
  assert.equal(integration.run, 'yarn workspace @happier-dev/cli test:integration');
  assert.equal(String(common.if), '${{ matrix.part == 1 && !cancelled() }}');

  const dispatched = [];
  for (const part of cli.strategy.matrix.part) {
    const env = {
      HAPPIER_CLI_VITEST_PART: String(part),
      HAPPIER_CLI_VITEST_PARTS: cli.env.HAPPIER_CLI_VITEST_PARTS,
    };
    const shardCount = resolveVitestShardCount(env, 'vitest.integration.config.ts');
    const range = resolveVitestShardRange(env, shardCount);
    const outcomes = await runCliVitestShardRuns({
      shardCount,
      startShard: range.start,
      endShard: range.end,
      runShard: async ({ shard }) => {
        dispatched.push(shard);
        return { ok: true, code: 0, signal: null };
      },
    });
    assert.deepEqual(outcomes.map(({ shard }) => shard), part === 1 ? [1, 2, 3, 4] : [5, 6, 7, 8]);
  }
  assert.deepEqual(dispatched, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('CLI collector requires unit and integration results in each part and common dist only in part one', async () => {
  const raw = await readFile(join(process.cwd(), '.github/workflows/tests.yml'), 'utf8');
  const workflow = YAML.parse(raw);
  const assertion = workflow.jobs.cli.steps.at(-1);

  for (const part of [1, 2]) {
    const success = {
      CLI_PART: String(part),
      UNIT_TESTS_OUTCOME: 'success',
      CLI_COMMON_DIST_OUTCOME: part === 1 ? 'success' : 'skipped',
      INTEGRATION_TESTS_OUTCOME: 'success',
    };
    const cases = [
      { outcomes: success, status: 0 },
      { outcomes: { ...success, UNIT_TESTS_OUTCOME: 'failure' }, status: 1 },
      { outcomes: { ...success, INTEGRATION_TESTS_OUTCOME: 'failure' }, status: 1 },
      { outcomes: { ...success, INTEGRATION_TESTS_OUTCOME: 'skipped' }, status: 1 },
      { outcomes: { ...success, CLI_COMMON_DIST_OUTCOME: 'failure' }, status: part === 1 ? 1 : 0 },
    ];
    for (const { outcomes, status } of cases) {
      // Execute only the existing outcome collector, never a test-lane command.
      const result = spawnSync('bash', ['-c', assertion.run], {
        encoding: 'utf8',
        env: { ...process.env, ...outcomes },
      });
      assert.equal(result.status, status, `${JSON.stringify(outcomes)}: ${result.stderr}`);
    }
  }
});
