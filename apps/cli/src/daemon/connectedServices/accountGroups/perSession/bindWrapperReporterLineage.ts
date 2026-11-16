import type { PerSessionAssignmentRunner } from './PerSessionAssignmentLedger';

/**
 * Binds a wrapper launch's reporting child to the wrapper's per-session decisions (R16-WRAPPER-02),
 * from identities read at the report itself (R19-WRAPPER-PRODUCER-01): the reporter's own process
 * instance, then its live parent with that parent's instance. The tracked session's fingerprint is
 * not used: when the report arrives it may be absent or still the wrapper's. Nothing is bound when
 * either instance is unknown, or when the reporter's instance changed between the two reads (the pid
 * was reused); the ledger binds only when the parent is exactly a decision's launched runner.
 */
export async function bindWrapperReporterLineage(input: Readonly<{
  reporterPid: number;
  readProcessInstance: (pid: number) => string | null;
  readParentProcess: (pid: number) => PerSessionAssignmentRunner | null;
  record: (lineage: Readonly<{ reporter: PerSessionAssignmentRunner; parent: PerSessionAssignmentRunner | null }>) => Promise<void>;
}>): Promise<void> {
  const reporterInstance = input.readProcessInstance(input.reporterPid);
  if (!reporterInstance) return;
  const parent = input.readParentProcess(input.reporterPid);
  if (!parent?.processInstanceFingerprint) return;
  if (input.readProcessInstance(input.reporterPid) !== reporterInstance) return;
  await input.record({ reporter: { pid: input.reporterPid, processInstanceFingerprint: reporterInstance }, parent });
}
