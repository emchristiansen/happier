import { describe, expect, it, vi } from 'vitest';

import { bindWrapperReporterLineage } from './bindWrapperReporterLineage';

describe('bindWrapperReporterLineage', () => {
  const parent = { pid: 42, processInstanceFingerprint: 'fp-42' };
  it('records the reporter with its own instance read at the report', async () => {
    const record = vi.fn(async () => {});
    await bindWrapperReporterLineage({ reporterPid: 77, readProcessInstance: () => 'fp-77', readParentProcess: () => parent, record });
    expect(record).toHaveBeenCalledWith({ reporter: { pid: 77, processInstanceFingerprint: 'fp-77' }, parent });
  });

  type Reader<T> = () => T;
  const cases: ReadonlyArray<readonly [string, Reader<string | null>, Reader<typeof parent | { pid: number } | null>]> = [
    ['the reporter instance is unknown', () => null, () => parent],
    ['the parent is unknown', () => 'fp-77', () => null],
    ['the parent has no instance', () => 'fp-77', () => ({ pid: 42 })],
  ];
  it.each(cases)('records nothing when %s', async (_label, readProcessInstance, readParentProcess) => {
    const record = vi.fn(async () => {});
    await bindWrapperReporterLineage({ reporterPid: 77, readProcessInstance, readParentProcess, record });
    expect(record).not.toHaveBeenCalled();
  });

  it('records nothing when the reporter pid was reused between the reads', async () => {
    const instances = ['fp-77', 'fp-reused'];
    const record = vi.fn(async () => {});
    await bindWrapperReporterLineage({ reporterPid: 77, readProcessInstance: () => instances.shift() ?? null, readParentProcess: () => parent, record });
    expect(record).not.toHaveBeenCalled();
  });
});
