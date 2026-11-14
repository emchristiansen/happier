import type { ConnectedServiceGroupMemberAssignmentReasonV1, ConnectedServiceId } from '@happier-dev/protocol';

import type { ConnectedServiceAssignmentReservationApi } from '@/api/connectedServices/connectedServiceAssignmentReservationApi';

import type { PerSessionAssignmentLedger, PerSessionAssignmentLedgerEntry } from './PerSessionAssignmentLedger';
import type { PerSessionSpawnAssignmentDeps } from './resolvePerSessionGroupMemberForSpawn';

/** Lease a live decision holds on the shared resource; renewed well before it lapses. */
export const PER_SESSION_RESERVATION_LEASE_MS = 5 * 60_000;
export const PER_SESSION_RESERVATION_RENEW_INTERVAL_MS = 60_000;
/** A decision with no live owner yet (spawn in flight, child not registered) is kept this long. */
export const PER_SESSION_UNOWNED_DECISION_GRACE_MS = 10 * 60_000;

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
 * - releases decisions with no live owner after a grace period.
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
    log?: Log;
  }>) {}

  get spawnDeps(): PerSessionSpawnAssignmentDeps {
    return {
      ledger: this.input.ledger,
      ownerMachineId: this.input.ownerMachineId,
      reservationApi: this.input.reservationApi,
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
    if (result.kind === 'conflict') {
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
    // The session now serves on this decision; its previously applied decision no longer counts.
    if (entry) {
      for (const superseded of this.input.ledger.list()) {
        if (superseded.decisionId !== params.decisionId && superseded.sessionId === entry.sessionId
          && superseded.serviceId === params.serviceId && superseded.groupId === params.groupId) {
          await this.release(superseded.decisionId);
        }
      }
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
    const entries = new Map(this.input.ledger.list().map((entry) => [entry.decisionId, entry]));

    for (const decision of live.values()) {
      const entry = entries.get(decision.decisionId);
      if (!entry) {
        await this.rebuild(decision);
      } else if (decision.applied && entry.state !== 'applied') {
        await this.input.ledger.markApplied(decision.decisionId, nowMs);
      }
      await this.renewSafely(decision, decision.applied ? 'applied' : 'pending');
    }

    for (const entry of entries.values()) {
      if (live.has(entry.decisionId)) continue;
      if (nowMs - entry.updatedAtMs < PER_SESSION_UNOWNED_DECISION_GRACE_MS) {
        await this.renewSafely({
          serviceId: entry.serviceId, groupId: entry.groupId, decisionId: entry.decisionId,
          profileId: entry.proposal.profileId, subjectId: entry.sessionId,
        }, entry.state);
        continue;
      }
      this.log('per_session_decision_released_unowned', { decisionId: entry.decisionId, sessionId: entry.sessionId });
      await this.release(entry.decisionId);
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
