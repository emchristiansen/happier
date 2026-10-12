import { describe, expect, it } from 'vitest';

import { buildExecutionRunCompletionInputV1 } from './executionRunCompletionV1.js';

describe('buildExecutionRunCompletionInputV1', () => {
  it('renders a tagged automated background notification with the canonical final result', () => {
    const input = buildExecutionRunCompletionInputV1({
      v: 1,
      runId: 'run_1',
      status: 'succeeded',
      finishedAtMs: 42,
      canInspect: true,
      summary: 'Done',
    });

    expect(input.text).toBe([
      '<happier_execution_run_notification>',
      'This is an automated background-run notification from Happier, not a user message.',
      'Run ID: run_1',
      'Status: succeeded',
      '',
      'Final result:',
      'Done',
      '</happier_execution_run_notification>',
    ].join('\n'));
    expect(input.text).not.toContain('{');
    expect((input.meta.happierStructuredInputV1 as Record<string, unknown>).executionRunCompletion)
      .toEqual({ v: 1, runId: 'run_1', status: 'succeeded', finishedAtMs: 42, canInspect: true, summary: 'Done' });
  });

  it.each(['failed', 'cancelled', 'timeout'] as const)(
    'identifies a %s completion without inventing a final result',
    (status) => {
      expect(buildExecutionRunCompletionInputV1({
        v: 1,
        runId: 'run_1',
        status,
        finishedAtMs: 42,
        canInspect: false,
      }).text).toBe([
        '<happier_execution_run_notification>',
        'This is an automated background-run notification from Happier, not a user message.',
        'Run ID: run_1',
        `Status: ${status}`,
        '</happier_execution_run_notification>',
      ].join('\n'));
    },
  );
});
