import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ConnectedServiceId } from '@happier-dev/protocol';

import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';

import type { PerSessionAssignmentProposal } from './decidePerSessionGroupMember';

/**
 * Durable per-daemon record of this daemon's per-session assignment decisions (spec A.3, A.5).
 *
 * It is the spawn-attempt record for initial decisions and the reservation-lease book for every
 * decision: local degraded counts, lease renewal, release and startup rebuild read it. Recovery
 * decisions are also owned by their durable recovery intent; this ledger never decides targets.
 */
export type PerSessionAssignmentLedgerEntry = Readonly<{
  decisionId: string;
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string;
  origin: 'spawn' | 'recovery';
  proposal: PerSessionAssignmentProposal;
  /** pending until provider adoption proof; applied afterwards. */
  state: 'pending' | 'applied';
  updatedAtMs: number;
  /**
   * The runner process launched for this decision, once one exists. Its proved absence is the
   * retirement evidence that lets an unowned decision be released (spec A.4, T17); a decision
   * without a recorded runner may still have a pending/pre-registration child and keeps custody.
   */
  runner?: PerSessionAssignmentRunner;
  /**
   * Earlier decisions of the same session this one replaces (pending targets that failed before
   * adoption, or reserved targets that became ineligible). They keep custody, untouched, until this
   * decision is adopted, which proves their runners were retired (spec A.5, T20).
   */
  replacesDecisionIds?: ReadonlyArray<string>;
  /**
   * When the spawn attempt entered a launch adapter for this decision. From then on a child may
   * exist before any runner is observable, so no pre-launch release is definite (spec A.4, T17).
   */
  launchAttemptedAtMs?: number;
  /** First proved provider activity on this applied decision's member (spec A.3). */
  firstProviderActivityAtMs?: number;
  /**
   * The shared reservation was released at the first fresh snapshot captured after first provider
   * activity (spec A.3). The decision still owns its session; only its reservation count ended.
   */
  reservationReleasedAtMs?: number;
}>;

export type PerSessionAssignmentRunner = Readonly<{ pid: number; processInstanceFingerprint?: string }>;

type LedgerSnapshot = Readonly<{ v: 1; entriesByDecisionId: Readonly<Record<string, PerSessionAssignmentLedgerEntry>> }>;

export function resolvePerSessionAssignmentLedgerPath(activeServerDir: string): string {
  return join(activeServerDir, 'connected-services', 'per-session-assignments.json');
}

function isEntry(value: unknown): value is PerSessionAssignmentLedgerEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.decisionId === 'string' && typeof entry.sessionId === 'string'
    && typeof entry.serviceId === 'string' && typeof entry.groupId === 'string'
    && (entry.state === 'pending' || entry.state === 'applied')
    && !!entry.proposal && typeof entry.proposal === 'object';
}

export class PerSessionAssignmentLedger {
  private readonly entries = new Map<string, PerSessionAssignmentLedgerEntry>();
  private writeQueue: Promise<void> = Promise.resolve();
  private sequence = 0;

  constructor(private readonly filePath: string) {
    this.loadFresh();
  }

  private loadFresh(): void {
    this.entries.clear();
    try {
      if (!existsSync(this.filePath)) return;
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<LedgerSnapshot>;
      if (parsed?.v !== 1 || !parsed.entriesByDecisionId) return;
      for (const entry of Object.values(parsed.entriesByDecisionId)) {
        if (isEntry(entry)) this.entries.set(entry.decisionId, entry);
      }
    } catch {
      this.entries.clear();
    }
  }

  private async persist(): Promise<void> {
    this.sequence += 1;
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.${this.sequence}.tmp`;
    const snapshot: LedgerSnapshot = { v: 1, entriesByDecisionId: Object.fromEntries(this.entries) };
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      await writeFile(tmpPath, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
      await rename(tmpPath, this.filePath);
      if (process.platform !== 'win32') await chmod(this.filePath, 0o600).catch(() => {});
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  }

  private async mutate<T>(mutation: () => T): Promise<T> {
    let result!: T;
    const run = this.writeQueue.catch(() => undefined).then(async () => {
      result = await withJsonOwnerFileLock({
        lockPath: `${this.filePath}.lock`,
        timeoutMs: 10_000,
        staleAfterMs: 30_000,
        errorCode: 'per_session_assignment_ledger_lock_timeout',
      }, async () => {
        this.loadFresh();
        const value = mutation();
        await this.persist();
        return value;
      });
    });
    this.writeQueue = run.catch(() => undefined);
    await run;
    return result;
  }

  async recordProposal(
    input: Omit<PerSessionAssignmentLedgerEntry, 'state' | 'updatedAtMs' | 'runner' | 'launchAttemptedAtMs' | 'firstProviderActivityAtMs' | 'reservationReleasedAtMs'>
      & Readonly<{ nowMs: number }>,
  ): Promise<void> {
    await this.mutate(() => {
      const previous = this.entries.get(input.decisionId);
      this.entries.set(input.decisionId, {
        decisionId: input.decisionId,
        sessionId: input.sessionId,
        serviceId: input.serviceId,
        groupId: input.groupId,
        origin: input.origin,
        proposal: input.proposal,
        state: previous?.state ?? 'pending',
        updatedAtMs: input.nowMs,
        ...(previous?.runner ? { runner: previous.runner } : {}),
        ...(previous?.launchAttemptedAtMs === undefined ? {} : { launchAttemptedAtMs: previous.launchAttemptedAtMs }),
        ...(previous?.firstProviderActivityAtMs === undefined ? {} : { firstProviderActivityAtMs: previous.firstProviderActivityAtMs }),
        ...(previous?.reservationReleasedAtMs === undefined ? {} : { reservationReleasedAtMs: previous.reservationReleasedAtMs }),
        ...((input.replacesDecisionIds ?? previous?.replacesDecisionIds)?.length
          ? { replacesDecisionIds: input.replacesDecisionIds ?? previous!.replacesDecisionIds! }
          : {}),
      });
    });
  }

  async markApplied(decisionId: string, nowMs: number): Promise<boolean> {
    return await this.mutate(() => {
      const entry = this.entries.get(decisionId);
      if (!entry) return false;
      this.entries.set(decisionId, { ...entry, state: 'applied', updatedAtMs: nowMs });
      return true;
    });
  }

  /** Records the runner launched for a decision; false when the decision is unknown. */
  async recordRunner(decisionId: string, runner: PerSessionAssignmentRunner, nowMs: number): Promise<boolean> {
    return await this.mutate(() => {
      const entry = this.entries.get(decisionId);
      if (!entry) return false;
      this.entries.set(decisionId, { ...entry, runner, updatedAtMs: nowMs });
      return true;
    });
  }

  /** Durably records that a launch adapter was entered for these decisions (before the launch). */
  async markLaunchAttempted(decisionIds: ReadonlyArray<string>, nowMs: number): Promise<void> {
    if (decisionIds.length === 0) return;
    await this.mutate(() => {
      for (const decisionId of decisionIds) {
        const entry = this.entries.get(decisionId);
        if (!entry || entry.launchAttemptedAtMs !== undefined) continue;
        this.entries.set(decisionId, { ...entry, launchAttemptedAtMs: nowMs, updatedAtMs: nowMs });
      }
    });
  }

  /** Records the first provider activity of an applied decision; later activity changes nothing. */
  async recordFirstProviderActivity(decisionId: string, atMs: number): Promise<boolean> {
    return await this.mutate(() => {
      const entry = this.entries.get(decisionId);
      if (!entry || entry.state !== 'applied' || entry.firstProviderActivityAtMs !== undefined) return false;
      this.entries.set(decisionId, { ...entry, firstProviderActivityAtMs: atMs, updatedAtMs: atMs });
      return true;
    });
  }

  async markReservationReleased(decisionId: string, nowMs: number): Promise<void> {
    await this.mutate(() => {
      const entry = this.entries.get(decisionId);
      if (!entry || entry.reservationReleasedAtMs !== undefined) return;
      this.entries.set(decisionId, { ...entry, reservationReleasedAtMs: nowMs, updatedAtMs: nowMs });
    });
  }

  async remove(decisionId: string): Promise<PerSessionAssignmentLedgerEntry | null> {
    return await this.mutate(() => {
      const entry = this.entries.get(decisionId) ?? null;
      this.entries.delete(decisionId);
      return entry;
    });
  }

  list(): PerSessionAssignmentLedgerEntry[] {
    this.loadFresh();
    return [...this.entries.values()];
  }

  get(decisionId: string): PerSessionAssignmentLedgerEntry | null {
    this.loadFresh();
    return this.entries.get(decisionId) ?? null;
  }

  /**
   * Live local decisions per member for degraded selection (pending and applied both count) until
   * their reservation is released.
   */
  localCounts(serviceId: ConnectedServiceId, groupId: string, excludeDecisionId?: string): Map<string, number> {
    const counts = new Map<string, number>();
    for (const entry of this.list()) {
      if (entry.serviceId !== serviceId || entry.groupId !== groupId || entry.decisionId === excludeDecisionId) continue;
      if (entry.reservationReleasedAtMs !== undefined) continue;
      counts.set(entry.proposal.profileId, (counts.get(entry.proposal.profileId) ?? 0) + 1);
    }
    return counts;
  }
}
