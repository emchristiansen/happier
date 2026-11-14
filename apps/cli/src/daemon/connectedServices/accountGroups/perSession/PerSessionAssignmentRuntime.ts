import type { ConnectedServiceGroupMemberAssignmentReasonV1, ConnectedServiceId } from '@happier-dev/protocol';

import type { ConnectedServiceAssignmentReservationApi } from '@/api/connectedServices/connectedServiceAssignmentReservationApi';

import type { PerSessionAssignmentLedger, PerSessionAssignmentLedgerEntry, PerSessionAssignmentRunner } from './PerSessionAssignmentLedger';
import type { PerSessionSpawnAssignmentDeps } from './resolvePerSessionGroupMemberForSpawn';

/** Lease a live decision holds on the shared resource; renewed well before it lapses. */
export const PER_SESSION_RESERVATION_LEASE_MS = 5 * 60_000;
export const PER_SESSION_RESERVATION_RENEW_INTERVAL_MS = 60_000;

/**
 * Whether the renewal loop may refresh this decision's lease. Renewal only extends a reservation the
 * server already admitted: an applied decision, or a pending one whose custody is `reserved`.
 * Proposed, uncertain and locally degraded custody is resolved only by the decision owner's
 * identical-request replay (spec A.5 R1–R5), never by a second writer.
 */
function isRenewable(entry: PerSessionAssignmentLedgerEntry | null): boolean {
  if (!entry) return true;
  return entry.state === 'applied' || entry.proposal.custody === 'reserved';
}

/** One spawn attempt's hold on the per-session decisions it created. */
export type PerSessionSpawnCustody = Readonly<{
  claim: (decisionIds: ReadonlyArray<string>) => void;
  /** Called immediately before the first launch adapter is entered; afterwards no release is definite. */
  markLaunchAttempted: () => void;
  recordRunner: (runner: PerSessionAssignmentRunner) => Promise<void>;
  releaseIfNeverLaunched: () => Promise<void>;
}>;

/** Positive process evidence for a recorded runner; only `absent` proves retirement. */
export type PerSessionRunnerPresence = 'absent' | 'present' | 'unknown';

/** A per-session decision a live runner currently carries in its bindings. */
export type PerSessionLiveDecision = Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  decisionId: string;
  profileId: string;
  /** Subject the decision was reserved under (the materialization identity). */
  subjectId: string;
  applied: boolean;
  reason: ConnectedServiceGroupMemberAssignmentReasonV1;
  fromProfileId?: string | null;
  temperature?: number;
  offsetPercent?: number;
  probability?: number | null;
}>;

type Log = (event: string, detail: Record<string, unknown>) => void;

/**
 * Daemon-side lifecycle of per-session assignment decisions (spec A.3, A.4):
 * - supplies spawn its ledger/reservation facilities;
 * - marks a decision applied (ledger and shared reservation) once adoption is proved;
 * - renews leases of decisions a live runner carries, rebuilding ledger entries the daemon lost;
 * - releases a decision only on positive evidence that no live or pending child owns it: a definite
 *   pre-launch failure, the observed retirement of its session, proved absence of its recorded
 *   runner process, or adoption of a replacement decision for the same session (spec A.4, T17).
 *   Elapsed time alone never releases custody; an unresolved decision keeps its lease.
 *
 * It never selects or changes a session's member; spawn and recovery own those decisions.
 */
export class PerSessionAssignmentRuntime {
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickInFlight: Promise<void> | null = null;

  constructor(private readonly input: Readonly<{
    ledger: PerSessionAssignmentLedger;
    ownerMachineId: string;
    reservationApi: ConnectedServiceAssignmentReservationApi | null;
    nowMs: () => number;
    listLiveDecisions: () => ReadonlyArray<PerSessionLiveDecision>;
    /** Subjects with a live runner; an applied decision such a runner no longer carries was replaced. */
    listLiveSubjectIds: () => ReadonlySet<string>;
    probeRunnerPresence: (runner: PerSessionAssignmentRunner) => Promise<PerSessionRunnerPresence>;
    log?: Log;
  }>) {}

  private readonly unresolvedLogged = new Set<string>();

  get spawnDeps(): PerSessionSpawnAssignmentDeps {
    return {
      ledger: this.input.ledger,
      ownerMachineId: this.input.ownerMachineId,
      reservationApi: this.input.reservationApi,
      releaseAfterDefinitePreLaunchFailure: async (decisionId) => await this.releaseAfterDefinitePreLaunchFailure(decisionId),
      ...(this.input.log ? { log: this.input.log } : {}),
    };
  }

  private log(event: string, detail: Record<string, unknown>): void {
    this.input.log?.(event, detail);
  }

  private async putLease(entry: Readonly<{
    serviceId: ConnectedServiceId; groupId: string; decisionId: string; profileId: string; subjectId: string;
  }>, state: 'pending' | 'applied'): Promise<void> {
    const api = this.input.reservationApi;
    if (!api) return;
    const body = {
      profileId: entry.profileId,
      sessionId: entry.subjectId,
      ownerMachineId: this.input.ownerMachineId,
      state,
      leaseUntilMs: this.input.nowMs() + PER_SESSION_RESERVATION_LEASE_MS,
      // Ignored for an existing decision; a lapsed one is recreated against the returned revision below.
      expectedReservationRevision: 0,
    };
    let result = await api.putAssignmentReservation({
      serviceId: entry.serviceId, groupId: entry.groupId, decisionId: entry.decisionId, body,
    });
    // Only an applied decision (its effect and adoption already proved) may recreate a lapsed entry;
    // admission of a not-yet-applied decision belongs to the decision owner's CAS selection (A.5 R2).
    if (result.kind === 'conflict' && state === 'applied') {
      // The entry lapsed (pruned) and must be recreated; this restores an existing decision's
      // count and never changes its target, so it retries against the returned revision.
      result = await api.putAssignmentReservation({
        serviceId: entry.serviceId, groupId: entry.groupId, decisionId: entry.decisionId,
        body: { ...body, expectedReservationRevision: result.reservationRevision },
      });
    }
    if (result.kind !== 'reserved') {
      this.log('per_session_reservation_lease_not_renewed', { decisionId: entry.decisionId, result: result.kind });
    }
  }

  /** Adoption proved for `decisionId` (spec A.5 C5): record applied in the ledger and the shared resource. */
  async markAdopted(params: Readonly<{ serviceId: ConnectedServiceId; groupId: string; decisionId: string; profileId: string }>): Promise<void> {
    const entry = this.input.ledger.get(params.decisionId);
    await this.input.ledger.markApplied(params.decisionId, this.input.nowMs());
    await this.putLease({
      serviceId: params.serviceId,
      groupId: params.groupId,
      decisionId: params.decisionId,
      profileId: params.profileId,
      subjectId: entry?.sessionId ?? params.decisionId,
    }, 'applied');
    // The session now serves on this decision: its previously applied decision no longer owns it,
    // and neither does any earlier target this decision replaced (transitively), since the adopted
    // runner replaced theirs. A different still-pending decision (a newer proposal) keeps custody.
    if (entry) {
      const replaced = new Set<string>();
      const pendingIds = [...(entry.replacesDecisionIds ?? [])];
      while (pendingIds.length > 0) {
        const id = pendingIds.pop()!;
        if (replaced.has(id)) continue;
        replaced.add(id);
        pendingIds.push(...(this.input.ledger.get(id)?.replacesDecisionIds ?? []));
      }
      for (const other of this.input.ledger.list()) {
        if (other.decisionId === params.decisionId || other.sessionId !== entry.sessionId
          || other.serviceId !== params.serviceId || other.groupId !== params.groupId) continue;
        if (other.state === 'applied' || replaced.has(other.decisionId)) {
          this.log(other.state === 'applied' ? 'per_session_decision_released_replaced_member' : 'per_session_decision_superseded', {
            decisionId: other.decisionId,
            supersededByDecisionId: params.decisionId,
            ...(other.state === 'applied' ? {} : { reason: 'target_failed_before_adoption' }),
          });
          await this.release(other.decisionId);
        }
      }
    }
  }

  /**
   * Custody of the decisions one spawn attempt creates: record the runner once a process exists, or
   * release them when the attempt ends before entering any launch adapter (spec A.4 definite
   * pre-launch failure). Once a launch was attempted, an unconfirmed outcome (no pid, hosted launch
   * unconfirmed, failed disposal) keeps custody until the runner's retirement is proved.
   */
  createSpawnCustody(): PerSessionSpawnCustody {
    let decisionIds: ReadonlyArray<string> = [];
    let launchAttempted = false;
    return {
      claim: (ids) => { decisionIds = [...ids]; },
      markLaunchAttempted: () => { launchAttempted = true; },
      recordRunner: async (runner) => {
        launchAttempted = true;
        for (const decisionId of decisionIds) await this.recordSpawnedRunner(decisionId, runner);
      },
      releaseIfNeverLaunched: async () => {
        if (launchAttempted) return;
        for (const decisionId of decisionIds) await this.releaseAfterDefinitePreLaunchFailure(decisionId);
        decisionIds = [];
      },
    };
  }

  /**
   * Provider adoption proved this session's conversion to the group's shared home (spec A.4
   * Migration): every per-session decision it still held for that group is retired.
   */
  async settleProvedSharedConversion(params: Readonly<{ subjectId: string; serviceId: ConnectedServiceId; groupId: string }>): Promise<void> {
    for (const entry of this.input.ledger.list()) {
      if (entry.sessionId !== params.subjectId || entry.serviceId !== params.serviceId || entry.groupId !== params.groupId) continue;
      this.log('per_session_decision_released_shared_conversion', { decisionId: entry.decisionId, sessionId: entry.sessionId });
      await this.release(entry.decisionId);
    }
  }

  /** The runner process launched for a spawn decision; its later proved absence is retirement evidence. */
  async recordSpawnedRunner(decisionId: string, runner: PerSessionAssignmentRunner): Promise<void> {
    await this.input.ledger.recordRunner(decisionId, runner, this.input.nowMs());
  }

  /**
   * The spawn attempt that created `decisionId` failed before any runner process existed. Only a
   * pending decision with no recorded runner qualifies: one that ever launched a child keeps custody
   * until that child's retirement is proved.
   */
  async releaseAfterDefinitePreLaunchFailure(decisionId: string): Promise<boolean> {
    const entry = this.input.ledger.get(decisionId);
    if (!entry || entry.state !== 'pending' || entry.origin !== 'spawn' || entry.runner) return false;
    this.log('per_session_decision_released_pre_launch_failure', { decisionId });
    await this.release(decisionId);
    return true;
  }

  /** The daemon observed these sessions' runners exit with no replacement: their decisions are retired. */
  async releaseForRetiredSubjects(subjectIds: ReadonlyArray<string>): Promise<void> {
    const subjects = new Set(subjectIds);
    if (subjects.size === 0) return;
    const live = new Set(this.input.listLiveDecisions().map((decision) => decision.decisionId));
    for (const entry of this.input.ledger.list()) {
      if (!subjects.has(entry.sessionId) || live.has(entry.decisionId)) continue;
      this.log('per_session_decision_released_session_retired', { decisionId: entry.decisionId, sessionId: entry.sessionId });
      await this.release(entry.decisionId);
    }
  }

  /** Release a decision that no longer owns a session (superseded, ended, or definitely never launched). */
  async release(decisionId: string): Promise<void> {
    const entry = await this.input.ledger.remove(decisionId);
    if (!entry || !this.input.reservationApi) return;
    const result = await this.input.reservationApi.deleteAssignmentReservation({
      serviceId: entry.serviceId, groupId: entry.groupId, decisionId,
    });
    if (result.kind !== 'ok') this.log('per_session_reservation_release_unsettled', { decisionId, result: result.kind });
  }

  /** One renewal pass: renew owned leases, rebuild entries for live decisions, release unowned ones. */
  async tick(): Promise<void> {
    if (this.tickInFlight) return await this.tickInFlight;
    this.tickInFlight = this.runTick().finally(() => { this.tickInFlight = null; });
    return await this.tickInFlight;
  }

  private async runTick(): Promise<void> {
    const nowMs = this.input.nowMs();
    const live = new Map(this.input.listLiveDecisions().map((decision) => [decision.decisionId, decision]));
    const liveSubjects = this.input.listLiveSubjectIds();
    const entries = new Map(this.input.ledger.list().map((entry) => [entry.decisionId, entry]));

    for (const decision of live.values()) {
      const entry = entries.get(decision.decisionId);
      if (!entry) {
        await this.rebuild(decision);
      } else if (decision.applied && entry.state !== 'applied') {
        await this.input.ledger.markApplied(decision.decisionId, nowMs);
      }
      if (decision.applied || isRenewable(entries.get(decision.decisionId) ?? null)) {
        await this.renewSafely(decision, decision.applied ? 'applied' : 'pending');
      }
    }

    for (const entry of entries.values()) {
      if (live.has(entry.decisionId)) continue;
      if (entry.state === 'applied' && liveSubjects.has(entry.sessionId)) {
        // The session's live runner serves on something else now (a later adopted decision or a
        // proved conversion to the group home): this applied decision no longer owns it.
        this.log('per_session_decision_released_replaced', { decisionId: entry.decisionId, sessionId: entry.sessionId });
        await this.release(entry.decisionId);
        continue;
      }
      if (entry.runner && await this.runnerProvedAbsent(entry.runner)) {
        this.log('per_session_decision_released_runner_absent', { decisionId: entry.decisionId, sessionId: entry.sessionId, pid: entry.runner.pid });
        await this.release(entry.decisionId);
        continue;
      }
      // No live owner yet and no retirement proof: a pending/pre-registration child may still own
      // it, so it keeps custody and its lease (spec A.4: lease expiry alone never frees it).
      if (!this.unresolvedLogged.has(entry.decisionId)) {
        this.unresolvedLogged.add(entry.decisionId);
        this.log('per_session_decision_unowned_custody_retained', {
          decisionId: entry.decisionId, sessionId: entry.sessionId, runnerRecorded: Boolean(entry.runner), ageMs: nowMs - entry.updatedAtMs,
        });
      }
      if (!isRenewable(entry)) continue;
      await this.renewSafely({
        serviceId: entry.serviceId, groupId: entry.groupId, decisionId: entry.decisionId,
        profileId: entry.proposal.profileId, subjectId: entry.sessionId,
      }, entry.state);
    }
  }

  private async runnerProvedAbsent(runner: PerSessionAssignmentRunner): Promise<boolean> {
    try {
      return (await this.input.probeRunnerPresence(runner)) === 'absent';
    } catch {
      return false;
    }
  }

  private async renewSafely(entry: Parameters<PerSessionAssignmentRuntime['putLease']>[0], state: 'pending' | 'applied'): Promise<void> {
    try {
      await this.putLease(entry, state);
    } catch (error) {
      this.log('per_session_reservation_lease_error', { decisionId: entry.decisionId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** A live runner carries a decision this ledger lost (daemon restart or another writer): adopt it. */
  private async rebuild(decision: PerSessionLiveDecision): Promise<void> {
    const proposal: PerSessionAssignmentLedgerEntry['proposal'] = {
      decisionId: decision.decisionId,
      profileId: decision.profileId,
      proposalRevision: 1,
      reason: decision.reason,
      fromProfileId: decision.fromProfileId ?? null,
      // Rebuilt from the binding: unknown parameters stay non-finite (absent), never re-derived.
      temperature: decision.temperature ?? Number.NaN,
      offsetPercent: decision.offsetPercent ?? Number.NaN,
      probability: decision.probability ?? null,
      decidedAtMs: this.input.nowMs(),
      custody: 'reserved',
      observedReservationRevision: null,
    };
    await this.input.ledger.recordProposal({
      decisionId: decision.decisionId,
      sessionId: decision.subjectId,
      serviceId: decision.serviceId,
      groupId: decision.groupId,
      origin: 'spawn',
      proposal,
      nowMs: this.input.nowMs(),
    });
    if (decision.applied) await this.input.ledger.markApplied(decision.decisionId, this.input.nowMs());
    this.log('per_session_decision_rebuilt', { decisionId: decision.decisionId, profileId: decision.profileId });
  }

  start(intervalMs: number = PER_SESSION_RESERVATION_RENEW_INTERVAL_MS): void {
    if (this.timer) return;
    void this.tick().catch(() => {});
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
