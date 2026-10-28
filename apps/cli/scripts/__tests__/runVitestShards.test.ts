import { describe, expect, it, vi } from 'vitest';

import {
  resolveVitestConfigPath,
  resolveVitestMaxWorkers,
  resolveVitestWorkerArgs,
  resolveVitestIsolationPlan,
  resolveVitestShardRange,
  resolveVitestShardCount,
  runCliVitestShardRuns,
} from '../runVitestShards.mjs';

describe('runVitestShards', () => {
  it('bounds inner Vitest concurrency for the process-heavy CLI unit lane', () => {
    expect(resolveVitestMaxWorkers({}, 'vitest.config.ts')).toBe(2);
    expect(resolveVitestWorkerArgs({}, 'vitest.config.ts')).toEqual(['--maxWorkers', '2']);
    expect(resolveVitestMaxWorkers({}, 'vitest.integration.config.ts')).toBe(null);
    expect(resolveVitestWorkerArgs({}, 'vitest.integration.config.ts')).toEqual([]);
  });

  it('accepts a positive inner-worker override and rejects invalid values', () => {
    expect(resolveVitestMaxWorkers({ HAPPIER_CLI_VITEST_MAX_WORKERS: '2' }, 'vitest.config.ts')).toBe(2);
    expect(resolveVitestMaxWorkers({ HAPPIER_CLI_VITEST_MAX_WORKERS: '0' }, 'vitest.config.ts')).toBe(2);
    expect(resolveVitestMaxWorkers({ HAPPIER_CLI_VITEST_MAX_WORKERS: 'many' }, 'vitest.config.ts')).toBe(2);
  });

  it('uses a smaller per-process unit slice while retaining the integration default', () => {
    expect(resolveVitestShardCount({}, 'vitest.config.ts')).toBe(64);
    expect(resolveVitestShardCount({}, 'vitest.integration.config.ts')).toBe(8);
  });

  it('uses HAPPIER_CLI_VITEST_SHARDS override when valid', () => {
    expect(resolveVitestShardCount({ HAPPIER_CLI_VITEST_SHARDS: '4' }, 'vitest.config.ts')).toBe(4);
  });

  it('ignores invalid shard overrides', () => {
    expect(resolveVitestShardCount({ HAPPIER_CLI_VITEST_SHARDS: '0' }, 'vitest.config.ts')).toBe(64);
    expect(resolveVitestShardCount({ HAPPIER_CLI_VITEST_SHARDS: 'nope' }, 'vitest.config.ts')).toBe(64);
  });

  it('partitions the configured shard count into balanced CI parts', () => {
    expect(resolveVitestShardRange({ HAPPIER_CLI_VITEST_PART: '1', HAPPIER_CLI_VITEST_PARTS: '2' }, 64)).toEqual({
      start: 1,
      end: 32,
      part: 1,
      parts: 2,
    });
    expect(resolveVitestShardRange({ HAPPIER_CLI_VITEST_PART: '2', HAPPIER_CLI_VITEST_PARTS: '2' }, 8)).toEqual({
      start: 5,
      end: 8,
      part: 2,
      parts: 2,
    });
  });

  it('runs the full shard range when partition inputs are absent or invalid', () => {
    expect(resolveVitestShardRange({}, 8)).toEqual({ start: 1, end: 8, part: 1, parts: 1 });
    expect(resolveVitestShardRange({ HAPPIER_CLI_VITEST_PART: '3', HAPPIER_CLI_VITEST_PARTS: '2' }, 8)).toEqual({
      start: 1,
      end: 8,
      part: 1,
      parts: 1,
    });
  });

  it('runs reset-heavy suites in bounded fresh processes', () => {
    const plan = resolveVitestIsolationPlan('vitest.config.ts');
    const resetHeavyFiles = [
      'src/daemon/startSyncOwnership.test.ts',
      'src/commands/auth.nonInteractiveBoth.test.ts',
      'src/api/session/sessionClient.durableMutationOutbox.test.ts',
      'src/agent/executionRuns/runEphemeralExecutionRunTextPrompt.test.ts',
    ];

    expect(plan.shardExcludes).toEqual(expect.arrayContaining(resetHeavyFiles));
    expect(new Set(plan.shardExcludes).size).toBe(plan.shardExcludes.length);
    expect(new Set(plan.runs.map((run) => run.file))).toEqual(new Set(plan.shardExcludes));
    for (const file of resetHeavyFiles) {
      expect(plan.runs).toContainEqual({ file, testNamePattern: '.*' });
    }

    // These exceptionally large suites intentionally remain split into several
    // fresh processes rather than one whole-file process.
    expect(plan.runs.filter((run) => run.file === 'src/daemon/service/cli.test.ts')).toHaveLength(3);
    expect(plan.runs.filter((run) => run.file === 'src/api/machine/rpcHandlers.sessionHandoff.test.ts')).toHaveLength(4);
    expect(resolveVitestIsolationPlan('vitest.integration.config.ts')).toEqual({
      shardExcludes: [],
      runs: [],
    });
  });

  it('parses --config path from argv', () => {
    expect(resolveVitestConfigPath(['node', 'run', '--config', 'vitest.integration.config.ts'])).toBe(
      'vitest.integration.config.ts',
    );
  });

  it.each([2, 3, 32])('distributes every isolated run exactly once across %i CI parts', (parts) => {
    const fullPlan = resolveVitestIsolationPlan('vitest.config.ts');
    const plans = Array.from({ length: parts }, (_, index) => resolveVitestIsolationPlan(
      'vitest.config.ts',
      resolveVitestShardRange({
        HAPPIER_CLI_VITEST_PART: String(index + 1),
        HAPPIER_CLI_VITEST_PARTS: String(parts),
      }, 64),
    ));

    for (const plan of plans) {
      expect(plan.shardExcludes).toEqual(fullPlan.shardExcludes);
    }
    const assignedRuns = plans.flatMap((plan) => plan.runs);
    expect(assignedRuns).toHaveLength(fullPlan.runs.length);
    expect(assignedRuns.map((run) => JSON.stringify(run)).sort()).toEqual(
      fullPlan.runs.map((run) => JSON.stringify(run)).sort(),
    );
    const runCounts = plans.map((plan) => plan.runs.length);
    expect(Math.max(...runCounts) - Math.min(...runCounts)).toBeLessThanOrEqual(1);
  });

  it('returns null when --config is missing', () => {
    expect(resolveVitestConfigPath(['node', 'run'])).toBe(null);
  });

  it('runs every later shard after an earlier shard fails', async () => {
    const runShard = vi.fn()
      .mockResolvedValueOnce({ ok: true, code: 1, signal: null })
      .mockResolvedValueOnce({ ok: true, code: 0, signal: null })
      .mockResolvedValueOnce({ ok: true, code: 1, signal: null });

    const outcomes = await runCliVitestShardRuns({ shardCount: 3, runShard });

    expect(runShard.mock.calls.map(([entry]) => entry.shard)).toEqual([1, 2, 3]);
    expect(outcomes.map((entry) => entry.outcome)).toEqual(['failed', 'passed', 'failed']);
  });

  it('runs only the assigned absolute shard range', async () => {
    const runShard = vi.fn().mockResolvedValue({ ok: true, code: 0, signal: null });

    const outcomes = await runCliVitestShardRuns({ shardCount: 8, startShard: 5, endShard: 8, runShard });

    expect(runShard.mock.calls.map(([entry]) => entry.shard)).toEqual([5, 6, 7, 8]);
    expect(outcomes.map((entry) => entry.shard)).toEqual([5, 6, 7, 8]);
  });
});
