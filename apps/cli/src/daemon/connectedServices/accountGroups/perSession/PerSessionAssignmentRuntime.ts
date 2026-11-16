import type { ConnectedServiceGroupMemberAssignmentReasonV1, ConnectedServiceId } from '@happier-dev/protocol';

import type { ConnectedServiceAssignmentReservationApi } from '@/api/connectedServices/connectedServiceAssignmentReservationApi';

import { isSamePerSessionRunner, type PerSessionAssignmentLedger, type PerSessionAssignmentLedgerEntry, type PerSessionAssignmentRunner } from './PerSessionAssignmentLedger';
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
  if (entry.reservationReleasedAtMs !== undefined) return false;
  return entry.state === 'applied' || entry.proposal.custody === 'reserved';
}

/** Every earlier decision `entry` replaces, transitively through the ledger. */
/**
 * The runner currently carrying a decision: the latest one launched with it, else the one its own
 * spawn started. An older runner's end says nothing about a later launch.
 */
function currentRunnerOf(entry: PerSessionAssignmentLedgerEntry): PerSessionAssignmentRunner | undefined {
  return entry.launchedRunner ?? entry.runner;
}

/**
 * Any live process tied to a decision: its current runner, else the runner observed carrying it. Used
 * for retirement and for refusing a "definitely pre-launch" release, never as launch evidence.
 */
function knownRunnerOf(entry: PerSessionAssignmentLedgerEntry): PerSessionAssignmentRunner | undefined {
  return currentRunnerOf(entry) ?? entry.carrierRunner;
}

/** Every distinct process the ledger ties to a decision (its spawn runner, latest launch and carrier). */
function knownRunnersOf(entry: PerSessionAssignmentLedgerEntry): PerSessionAssignmentRunner[] {
  const runners: PerSessionAssignmentRunner[] = [];
  for (const runner of [entry.launchedRunner, entry.runner, entry.launchedReporter, entry.carrierRunner]) {
    if (runner && !runners.some((known) => isSamePerSessionRunner(known, runner))) runners.push(runner);
  }
  return runners;
}

/** A pending decision whose launch may have started a child that no runner record names yet. */
function isUncertainLaunch(entry: PerSessionAssignmentLedgerEntry): boolean {
  return entry.state === 'pending' && entry.launchAttemptedAtMs !== undefined && currentRunnerOf(entry) === undefined;
}

/** A pending decision recovery owns: drawn by recovery, or replacing earlier decisions of its subject. */
function isUnfinishedRecovery(entry: PerSessionAssignmentLedgerEntry): boolean {
  return entry.state === 'pending' && (entry.origin === 'recovery' || (entry.replacesDecisionIds?.length ?? 0) > 0);
}

function replacedClosure(entry: PerSessionAssignmentLedgerEntry, byId: ReadonlyMap<string, PerSessionAssignmentLedgerEntry>): Set<string> {
  const replaced = new Set<string>();
  const pendingIds = [...(entry.replacesDecisionIds ?? [])];
  while (pendingIds.length > 0) {
    const id = pendingIds.pop()!;
    if (replaced.has(id) || id === entry.decisionId) continue;
    replaced.add(id);
    pendingIds.push(...(byId.get(id)?.replacesDecisionIds ?? []));
  }
  return replaced;
}

function sameSubject(left: PerSessionAssignmentLedgerEntry, right: Readonly<{ sessionId: string; serviceId: ConnectedServiceId; groupId: string }>): boolean {
  return left.sessionId === right.sessionId && left.serviceId === right.serviceId && left.groupId === right.groupId;
}

/** One spawn attempt's hold on the per-session decisions it created. */
export type PerSessionSpawnCustody = Readonly<{
  claim: (decisionIds: ReadonlyArray<string>) => void;
  /** Every decision the launch will carry (owned or reused); the started runner is recorded on each. */
  claimLaunched: (decisionIds: ReadonlyArray<string>) => void;
  /**
   * Durably records, immediately before the first launch adapter is entered, that a child may now
   * exist; afterwards no release is definite, across daemon restarts too.
   */
  markLaunchAttempted: () => Promise<void>;
  recordRunner: (runner: PerSessionAssignmentRunner) => Promise<void>;
  releaseIfNeverLaunched: () => Promise<void>;
}>;

/** Positive process evidence for a recorded runner; only `absent` proves retirement. */
export type PerSessionRunnerPresence = 'absent' | 'present' | 'unknown';

/**
 * A proved conversion of a session to its group's shared home (spec A.4 Migration). It retires the
 * per-session decisions made at or before the conversion target was materialized, never a later one.
 */
export type PerSessionProvedSharedConversion = Readonly<{
  subjectId: string;
  serviceId: ConnectedServiceId;
  groupId: string;
  retiresDecisionsDecidedAtOrBeforeMs: number;
  /**
   * The runner whose launch on the group home proved the conversion. It runs on the group home, so a
   * per-session decision it still lists (its launch binding keeps the previous member until adoption,
   * and its local metadata can lag the committed conversion) is not served by it (T12-CONV-01).
   */
  convertedRunner?: PerSessionAssignmentRunner;
}>;

/**
 * A live listing retired by a proved conversion (R20-CONVERSION-REBUILD-01): every carrier is exactly
 * the converted runner of a conversion of the same subject and group, and the binding recorded the
 * decision at or before the conversion. That runner serves the group home; its lagging listing is not
 * a live decision and is never rebuilt, marked applied or renewed. Any other carrier keeps it live.
 */
function isRetiredByProvedConversion(
  decision: PerSessionLiveDecision,
  conversions: ReadonlyArray<PerSessionProvedSharedConversion>,
): boolean {
  const carriers = decision.carriers ?? [decision.runner ?? null];
  if (carriers.length === 0 || decision.recordedAtMs === undefined) return false;
  return conversions.some((conversion) => {
    const converted = conversion.convertedRunner;
    return converted !== undefined
      && conversion.subjectId === decision.subjectId
      && conversion.serviceId === decision.serviceId
      && conversion.groupId === decision.groupId
      && decision.recordedAtMs! <= conversion.retiresDecisionsDecidedAtOrBeforeMs
      && carriers.every((carrier) => carrier !== null && isExactRunnerInstance(carrier, converted));
  });
}

/** Exactly the same process instance: equal pid and equal, known fingerprints on both sides. */
function isExactRunnerInstance(left: PerSessionAssignmentRunner, right: PerSessionAssignmentRunner): boolean {
  return left.pid === right.pid && left.processInstanceFingerprint !== undefined
    && left.processInstanceFingerprint === right.processInstanceFingerprint;
}

/** A per-session decision a live runner currently carries in its bindings. */
export type PerSessionLiveDecision = Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  decisionId: string;
  profileId: string;
  /** Subject the decision was reserved under (the materialization identity). */
  subjectId: string;
  applied: boolean;
  /**
   * When the session binding recorded this decision (the applied member's `appliedAtMs`, the pending
   * target's `materializedAtMs`); a rebuilt entry takes it as its decision time, never "now".
   */
  recordedAtMs?: number;
  reason: ConnectedServiceGroupMemberAssignmentReasonV1;
  fromProfileId?: string | null;
  temperature?: number;
  offsetPercent?: number;
  probability?: number | null;
  /** The live runner carrying the decision; a rebuilt entry keeps it for later retirement (HPI-33). */
  runner?: PerSessionAssignmentRunner;
  /**
   * Every live runner carrying the decision (null for a runner whose identity is unknown). Several
   * runners of one session may carry it at once, e.g. an old member-home runner and the runner
   * converting the session (R19-CONV-MULTIPLICITY-01). Absent means `[runner ?? null]`.
   */
  carriers?: ReadonlyArray<PerSessionAssignmentRunner | null>;
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
  /** Conversions this daemon settled, until their subject has no live runner (R20-CONVERSION-REBUILD-01). */
  private readonly settledConversions = new Map<string, PerSessionProvedSharedConversion>();
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
    /** Live runners whose committed metadata proves conversion to the group's shared home. */
    listProvedSharedConversions?: () => ReadonlyArray<PerSessionProvedSharedConversion>;
    /**
     * The earliest capture time of the member's freshest quota snapshot this daemon holds, if that
     * snapshot is still fresh at `nowMs` and proves its capture time; otherwise null. Read only after
     * proved provider activity (spec A.3).
     */
    readMemberSnapshotCapturedAtOrAfterMs?: (input: Readonly<{ serviceId: ConnectedServiceId; groupId: string; profileId: string; nowMs: number }>) => number | null;
    log?: Log;
  }>) {}

  private readonly unresolvedLogged = new Set<string>();

  get spawnDeps(): PerSessionSpawnAssignmentDeps {
    return {
      ledger: this.input.ledger,
      ownerMachineId: this.input.ownerMachineId,
      reservationApi: this.input.reservationApi,
      releaseAfterDefinitePreLaunchFailure: async (decisionId) => await this.releaseAfterDefinitePreLaunchFailure(decisionId),
      releaseReplayedSpawnDecision: async (decisionId) => await this.releaseReplayedSpawnDecision(decisionId),
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

  /**
   * Adoption proved for `decisionId` (spec A.5 C5): record applied in the ledger, settle what it
   * replaced, then renew the shared reservation as applied. Each step is idempotent and the renewal
   * tick repeats the first two from the durable ledger and live bindings, so a failure partway
   * (after metadata commit, after mark-applied, during the reservation update or during
   * settlement) is completed later rather than lost.
   */
  async markAdopted(params: Readonly<{ serviceId: ConnectedServiceId; groupId: string; decisionId: string; profileId: string }>): Promise<void> {
    const entry = this.input.ledger.get(params.decisionId);
    await this.input.ledger.markApplied(params.decisionId, this.input.nowMs());
    if (entry) await this.settleAdoption({ ...entry, state: 'applied' }, { includePreviouslyApplied: true });
    await this.putLease({
      serviceId: params.serviceId,
      groupId: params.groupId,
      decisionId: params.decisionId,
      profileId: params.profileId,
      subjectId: entry?.sessionId ?? params.decisionId,
    }, 'applied');
  }

  /**
   * The session now serves on `adopted`: every earlier target it replaced (transitively) is retired
   * with the runner the adopted one replaced, and on direct adoption so is the previously applied
   * member. A different still-pending decision (a newer proposal) keeps custody.
   */
  private async settleAdoption(adopted: PerSessionAssignmentLedgerEntry, options: Readonly<{ includePreviouslyApplied: boolean }>): Promise<void> {
    const entries = this.input.ledger.list();
    const replaced = replacedClosure(adopted, new Map(entries.map((entry) => [entry.decisionId, entry])));
    for (const other of entries) {
      if (other.decisionId === adopted.decisionId || !sameSubject(other, adopted)) continue;
      const previouslyApplied = options.includePreviouslyApplied && other.state === 'applied';
      if (!previouslyApplied && !replaced.has(other.decisionId)) continue;
      this.log(previouslyApplied ? 'per_session_decision_released_replaced_member' : 'per_session_decision_superseded', {
        decisionId: other.decisionId,
        supersededByDecisionId: adopted.decisionId,
        ...(previouslyApplied ? {} : { reason: 'target_failed_before_adoption' }),
      });
      await this.release(other.decisionId);
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
    let launchedDecisionIds: ReadonlyArray<string> = [];
    let launchAttempted = false;
    return {
      claim: (ids) => { decisionIds = [...ids]; },
      claimLaunched: (ids) => { launchedDecisionIds = [...ids]; },
      markLaunchAttempted: async () => {
        // Durable before any launch adapter runs; if the write fails nothing has launched yet and
        // the caller's failure path may still release them as a definite pre-launch failure.
        await this.input.ledger.markLaunchAttempted(decisionIds, this.input.nowMs());
        launchAttempted = true;
      },
      recordRunner: async (runner) => {
        launchAttempted = true;
        await this.input.ledger.recordSpawnCustody({
          spawnDecisionIds: decisionIds, launchedDecisionIds, runner, nowMs: this.input.nowMs(),
        });
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
   * Migration): the per-session decisions it retires (made at or before the conversion target was
   * materialized, and not carried by a live runner) are released. A later decision is kept.
   */
  async settleProvedSharedConversion(conversion: PerSessionProvedSharedConversion): Promise<void> {
    this.log('per_session_shared_conversion_proved', { ...conversion });
    this.settledConversions.set(`${conversion.subjectId}\u0000${conversion.serviceId}\u0000${conversion.groupId}`, conversion);
    // A decision stays live while any runner other than the converted one (exactly that process
    // instance) carries it, or a carrier's identity is unknown. The converted runner's own listing
    // lags (its launch binding keeps the previous member until adoption) and never keeps it alive.
    const converted = conversion.convertedRunner;
    const live = new Set(this.input.listLiveDecisions()
      .filter((decision) => (decision.carriers ?? [decision.runner ?? null]).some((carrier) => (
        carrier === null || !converted || decision.subjectId !== conversion.subjectId || !isExactRunnerInstance(carrier, converted)
      )))
      .map((decision) => decision.decisionId));
    for (const entry of this.input.ledger.list()) {
      if (!sameSubject(entry, { ...conversion, sessionId: conversion.subjectId })) continue;
      if (live.has(entry.decisionId) || !(entry.proposal.decidedAtMs <= conversion.retiresDecisionsDecidedAtOrBeforeMs)) {
        this.log('per_session_decision_kept_by_shared_conversion', {
          decisionId: entry.decisionId, sessionId: entry.sessionId, live: live.has(entry.decisionId),
          decidedAtMs: entry.proposal.decidedAtMs, retiresAtOrBeforeMs: conversion.retiresDecisionsDecidedAtOrBeforeMs,
        });
        continue;
      }
      this.log('per_session_decision_released_shared_conversion', { decisionId: entry.decisionId, sessionId: entry.sessionId });
      await this.release(entry.decisionId);
    }
  }

  /**
   * Whether `decisionId` was launched in `runner`: the ledger's launch custody of that decision (its
   * latest launch, else the runner its own spawn recorded, as `currentRunnerOf`) names this process.
   * Provenance for provider adoption (spec A.5 C4): evidence from any other process (an earlier
   * runner, a replaced one) never adopts the decision. The spawn record alone suffices because launch
   * custody is two commits and a surviving child must stay adoptable when the second one is lost
   * (T5/T19). A runner merely observed carrying the decision (`carrierRunner`, from mutable session
   * metadata) is never launch evidence. `requireFingerprint` demands an exact process-instance match,
   * for identities not taken from the daemon's own tracking.
   */
  isDecisionLaunchedInRunner(
    decisionId: string,
    runner: PerSessionAssignmentRunner,
    options: Readonly<{ requireFingerprint?: boolean }> = {},
  ): boolean {
    const entry = this.input.ledger.get(decisionId);
    const launched = entry ? currentRunnerOf(entry) : undefined;
    if (!launched) return false;
    // The wrapper launch's own reporter child, bound by exact process instance (R16-WRAPPER-02).
    const reporter = entry?.launchedReporter;
    if (reporter && reporter.pid === runner.pid && reporter.processInstanceFingerprint !== undefined
      && reporter.processInstanceFingerprint === runner.processInstanceFingerprint) return true;
    if (options.requireFingerprint) {
      return launched.pid === runner.pid
        && launched.processInstanceFingerprint !== undefined
        && launched.processInstanceFingerprint === runner.processInstanceFingerprint;
    }
    return isSamePerSessionRunner(launched, runner);
  }

  /**
   * A wrapper launch reported its session-runner child: bind that child to the decisions the wrapper
   * was launched with, while the wrapper is its live parent, so the same child stays adoptable after
   * the wrapper exits and the child is reparented (R16-WRAPPER-02). `parent` is the reporter's live
   * parent read with its process instance; nothing is bound without both instances.
   */
  async recordWrapperReporter(input: Readonly<{
    reporter: PerSessionAssignmentRunner;
    parent: PerSessionAssignmentRunner | null;
  }>): Promise<void> {
    if (!input.parent) return;
    const bound = await this.input.ledger.recordLaunchedReporter({
      launcher: input.parent, reporter: input.reporter, nowMs: this.input.nowMs(),
    });
    if (bound.length > 0) {
      this.log('per_session_wrapper_reporter_bound', { decisionIds: bound, reporter: input.reporter, launcher: input.parent });
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
    if (!entry || entry.state !== 'pending' || entry.origin !== 'spawn' || knownRunnerOf(entry) || entry.launchAttemptedAtMs !== undefined) return false;
    this.log('per_session_decision_released_pre_launch_failure', { decisionId });
    await this.release(decisionId);
    return true;
  }

  /**
   * A replayed spawn found its earlier unadopted decision unusable. It is released only with positive
   * evidence that no child of the earlier attempt can still own the session: no launch adapter was
   * ever entered, or its recorded runner is proved absent. A launch attempted without an observed
   * runner, or a runner not proved absent, keeps custody (false): the caller must not draw again.
   */
  async releaseReplayedSpawnDecision(decisionId: string): Promise<boolean> {
    const entry = this.input.ledger.get(decisionId);
    if (!entry) return true;
    if (entry.state !== 'pending' || entry.origin !== 'spawn') return false;
    // Every process tied to the decision must be proved gone: an older launch record and a newer
    // observed carrier may each be the one still owning the session.
    const known = knownRunnersOf(entry);
    if (known.length > 0) {
      for (const runner of known) if (!await this.runnerProvedAbsent(runner)) return false;
      this.log('per_session_decision_released_runner_absent', { decisionId, sessionId: entry.sessionId, pids: known.map((runner) => runner.pid) });
    } else if (entry.launchAttemptedAtMs !== undefined) {
      this.log('per_session_decision_launch_unsettled', { decisionId, sessionId: entry.sessionId, launchAttemptedAtMs: entry.launchAttemptedAtMs });
      return false;
    } else {
      this.log('per_session_decision_released_pre_launch_failure', { decisionId });
    }
    await this.release(decisionId);
    return true;
  }

  /**
   * Proved provider activity on the session's applied member(s) (spec A.3): records the first
   * activity of each applied decision the session's runner carries. Pending targets are not credited.
   */
  async recordProviderActivity(params: Readonly<{ decisions: ReadonlyArray<PerSessionLiveDecision>; observedAtMs: number }>): Promise<void> {
    for (const decision of params.decisions) {
      if (!decision.applied) continue;
      const entry = this.input.ledger.get(decision.decisionId);
      if (!entry || entry.state !== 'applied' || entry.proposal.profileId !== decision.profileId) continue;
      if (await this.input.ledger.recordFirstProviderActivity(decision.decisionId, params.observedAtMs)) {
        this.log('per_session_decision_first_provider_activity', { decisionId: decision.decisionId, observedAtMs: params.observedAtMs });
      }
    }
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

  /**
   * Startup found these runners' sessions ended while the daemon was down (dead daemon-session
   * markers, not recovered live; a marker is dead only when no process holds its pid). A session
   * whose settled decisions recorded one of these runners has ended, so they are retired (spec A.3 T14).
   */
  async releaseForEndedRunnerPids(pids: ReadonlyArray<number>): Promise<void> {
    const ended = new Set(pids);
    if (ended.size === 0) return;
    const entries = this.input.ledger.list();
    // An unfinished recovery may still be resumed by its durable owner, and a launch attempted but not
    // yet recorded may have started a child; a dead old runner proves neither ended (HPI-01). Such a
    // subject keeps every decision until adoption, its own runner's end, or terminal proof.
    const unsettled = new Set(entries
      .filter((entry) => isUnfinishedRecovery(entry) || isUncertainLaunch(entry))
      .map((entry) => entry.sessionId));
    // A wrapper launch's bound reporter child outlives the wrapper (R20-REPORTER-RETIRE-01): a subject
    // naming one whose own pid did not end is left to the renewal tick's exact probe.
    const reporterMayLive = new Set(entries
      .filter((entry) => entry.launchedReporter !== undefined && !ended.has(entry.launchedReporter.pid))
      .map((entry) => entry.sessionId));
    const subjects = new Set<string>();
    for (const entry of entries) {
      if (unsettled.has(entry.sessionId) || reporterMayLive.has(entry.sessionId)) continue;
      const known = knownRunnerOf(entry);
      if (known && ended.has(known.pid)) subjects.add(entry.sessionId);
    }
    await this.releaseForRetiredSubjects([...subjects]);
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
    const liveSubjects = this.input.listLiveSubjectIds();
    for (const [key, conversion] of this.settledConversions) {
      if (!liveSubjects.has(conversion.subjectId)) this.settledConversions.delete(key);
    }
    const listedConversions = this.input.listProvedSharedConversions?.() ?? [];
    const conversions = [...this.settledConversions.values(), ...listedConversions];
    const live = new Map(this.input.listLiveDecisions()
      .filter((decision) => !isRetiredByProvedConversion(decision, conversions))
      .map((decision) => [decision.decisionId, decision]));
    let entries = new Map(this.input.ledger.list().map((entry) => [entry.decisionId, entry]));

    for (const decision of live.values()) {
      const entry = entries.get(decision.decisionId);
      if (!entry) {
        await this.rebuild(decision);
        continue;
      }
      if (decision.applied && entry.state !== 'applied') await this.input.ledger.markApplied(decision.decisionId, nowMs);
      await this.recordServingRunner(decision, entry);
    }

    // Durable settlement (spec A.5 T20, A.4 Migration): completes adoption and conversion
    // settlement that an earlier callback did not finish (crash or failure partway).
    entries = new Map(this.input.ledger.list().map((entry) => [entry.decisionId, entry]));
    for (const entry of entries.values()) {
      if (entry.state === 'applied' && live.get(entry.decisionId)?.applied) await this.settleAdoption(entry, { includePreviouslyApplied: false });
    }
    for (const conversion of listedConversions) {
      await this.settleProvedSharedConversion(conversion);
    }
    entries = new Map(this.input.ledger.list().map((entry) => [entry.decisionId, entry]));
    await this.releaseReservationsAfterActivitySnapshot(entries, live, nowMs);
    entries = new Map(this.input.ledger.list().map((entry) => [entry.decisionId, entry]));

    for (const decision of live.values()) {
      const entry = entries.get(decision.decisionId) ?? null;
      if (entry?.reservationReleasedAtMs !== undefined) continue;
      if (decision.applied || isRenewable(entry)) {
        await this.renewSafely(decision, decision.applied ? 'applied' : 'pending');
      }
    }

    // A decision some unreleased successor still replaces keeps custody until that successor is
    // adopted or released, or the session retires: its old runner's retirement is not the end of
    // the session while the successor owns it (spec A.5 T20).
    const replacedByUnsettledSuccessor = new Set<string>();
    // Sessions with unfinished recovery or launch: any pending decision.
    const subjectsWithPendingDecision = new Set<string>();
    for (const entry of entries.values()) {
      if (entry.state !== 'pending') continue;
      subjectsWithPendingDecision.add(entry.sessionId);
      for (const id of replacedClosure(entry, entries)) replacedByUnsettledSuccessor.add(id);
    }

    for (const entry of entries.values()) {
      if (live.has(entry.decisionId)) continue;
      const successorOwned = replacedByUnsettledSuccessor.has(entry.decisionId);
      if (!successorOwned && entry.state === 'applied' && liveSubjects.has(entry.sessionId)) {
        // The session's live runner serves on something else now (a later adopted decision or a
        // proved conversion to the group home): this applied decision no longer owns it.
        this.log('per_session_decision_released_replaced', { decisionId: entry.decisionId, sessionId: entry.sessionId });
        await this.release(entry.decisionId);
        continue;
      }
      // A dead runner is not the end of a session whose recovery is unfinished: a pending recovery or
      // replacing decision, or an applied one while its session still has a pending decision, keeps
      // custody until a later decision is adopted, conversion is proved, or the session's end is
      // observed (spec A.5 T20). A settled decision (a lone spawn, or an applied one with nothing
      // pending) is retired when the runner recorded for it is proved gone (spec A.3 T14).
      const recoveryOwned = entry.state === 'pending'
        ? isUnfinishedRecovery(entry)
        : subjectsWithPendingDecision.has(entry.sessionId);
      const recordedRunner = currentRunnerOf(entry);
      // The launch's bound reporter child (exact instance) is a live witness of the same launch: both
      // must be proved absent (R20-REPORTER-RETIRE-01).
      if (!successorOwned && !recoveryOwned && recordedRunner && await this.runnerProvedAbsent(recordedRunner)
        && (!entry.launchedReporter || await this.runnerProvedAbsent(entry.launchedReporter))) {
        this.log('per_session_decision_released_runner_absent', { decisionId: entry.decisionId, sessionId: entry.sessionId, pid: recordedRunner.pid });
        await this.release(entry.decisionId);
        continue;
      }
      // No live owner yet and no retirement proof: a pending/pre-registration child or an unsettled
      // successor may still own it, so it keeps custody and its lease (spec A.4: lease expiry alone
      // never frees it).
      if (!this.unresolvedLogged.has(entry.decisionId)) {
        this.unresolvedLogged.add(entry.decisionId);
        this.log('per_session_decision_unowned_custody_retained', {
          decisionId: entry.decisionId, sessionId: entry.sessionId, runnerRecorded: Boolean(entry.runner),
          launchAttempted: entry.launchAttemptedAtMs !== undefined, successorOwned, recoveryOwned, ageMs: nowMs - entry.updatedAtMs,
        });
      }
      if (!isRenewable(entry)) continue;
      await this.renewSafely({
        serviceId: entry.serviceId, groupId: entry.groupId, decisionId: entry.decisionId,
        profileId: entry.proposal.profileId, subjectId: entry.sessionId,
      }, entry.state);
    }
  }

  /**
   * Spec A.3: an applied decision's shared reservation ends at the first fresh snapshot of its member
   * captured after the session's first proved provider activity on it. Snapshot fetch time without
   * activity proof, a snapshot captured before the activity, or another member's snapshot does not
   * release. The decision keeps owning its session; it is only no longer counted or renewed.
   */
  private async releaseReservationsAfterActivitySnapshot(
    entries: ReadonlyMap<string, PerSessionAssignmentLedgerEntry>,
    live: ReadonlyMap<string, PerSessionLiveDecision>,
    nowMs: number,
  ): Promise<void> {
    const readCapturedAt = this.input.readMemberSnapshotCapturedAtOrAfterMs;
    if (!readCapturedAt) return;
    for (const entry of entries.values()) {
      const activityAtMs = entry.firstProviderActivityAtMs;
      if (entry.state !== 'applied' || activityAtMs === undefined || entry.reservationReleasedAtMs !== undefined) continue;
      if (!live.get(entry.decisionId)?.applied) continue;
      const capturedAtMs = readCapturedAt({ serviceId: entry.serviceId, groupId: entry.groupId, profileId: entry.proposal.profileId, nowMs });
      if (capturedAtMs === null || !(capturedAtMs > activityAtMs)) continue;
      try {
        const result = this.input.reservationApi
          ? await this.input.reservationApi.deleteAssignmentReservation({ serviceId: entry.serviceId, groupId: entry.groupId, decisionId: entry.decisionId })
          : { kind: 'ok' as const };
        if (result.kind !== 'ok') {
          this.log('per_session_reservation_release_unsettled', { decisionId: entry.decisionId, result: result.kind });
          continue;
        }
        await this.input.ledger.markReservationReleased(entry.decisionId, nowMs);
        this.log('per_session_reservation_released_after_activity_snapshot', {
          decisionId: entry.decisionId, profileId: entry.proposal.profileId, firstProviderActivityAtMs: activityAtMs, snapshotCapturedAtMs: capturedAtMs,
        });
      } catch (error) {
        this.log('per_session_reservation_lease_error', { decisionId: entry.decisionId, error: error instanceof Error ? error.message : String(error) });
      }
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

  /**
   * Records the live runner serving an applied decision whenever the ledger does not name it already,
   * so its next offline end can be reconciled (HPI-33). Idempotent: a rebuild or earlier tick cut
   * before this write is completed by the next healthy observation (HPI-36). A pending target is never
   * credited with a launch: its bindings name it before any launch (HPI-21). Its runner is recorded
   * only as its carrier.
   */
  private async recordServingRunner(decision: PerSessionLiveDecision, entry: PerSessionAssignmentLedgerEntry | null | undefined): Promise<void> {
    if (!decision.runner || !entry) return;
    if (!decision.applied) {
      // A pending target: only its carrier is known, never its launch.
      if (entry.carrierRunner && isSamePerSessionRunner(entry.carrierRunner, decision.runner)) return;
      await this.input.ledger.recordCarrierRunner(decision.decisionId, decision.runner, this.input.nowMs());
      return;
    }
    const current = currentRunnerOf(entry);
    if (current && isSamePerSessionRunner(current, decision.runner)) return;
    await this.input.ledger.recordLaunchedRunner([decision.decisionId], decision.runner, this.input.nowMs());
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
      // The binding's own record time, never now: a later rebuild must not look newer than a
      // conversion that retires it (R20-CONVERSION-REBUILD-01).
      decidedAtMs: decision.recordedAtMs ?? this.input.nowMs(),
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
    await this.recordServingRunner(decision, this.input.ledger.get(decision.decisionId));
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
