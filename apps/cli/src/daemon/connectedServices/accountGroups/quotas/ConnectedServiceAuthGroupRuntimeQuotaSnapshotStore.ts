import type {
  ConnectedServiceAuthGroupQuotaLimitSelectionV1,
  ConnectedServiceId,
  ConnectedServiceQuotaSnapshotV1,
  ProviderAccountUsageOrganizationContext,
} from '@happier-dev/protocol';
import { compareConnectedServiceQuotaObservationRecency, isProviderAccountUsageOrganizationContextMatch } from '@happier-dev/protocol';

import { resolveFreshQuotaSnapshotCapturedAtOrAfterMs } from '../../quotas/resolveFreshQuotaSnapshotCapturedAtOrAfterMs';
import type { ConnectedServiceAuthGroupMemberRuntimeState } from '../selection/selectConnectedServiceAuthGroupCandidate';
import { buildConnectedServiceAuthGroupRuntimeStateFromMeters } from './projection';

type SnapshotKeyInput = Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  profileId: string;
  groupGeneration?: number | null;
}>;

type ProfileSnapshotKeyInput = Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
}>;

function snapshotKey(input: SnapshotKeyInput): string {
  return `${input.serviceId}\0${input.groupId}\0${input.profileId}`;
}

function profileSnapshotKey(input: ProfileSnapshotKeyInput): string {
  return `${input.serviceId}\0${input.profileId}`;
}

function readFetchedAt(snapshot: ConnectedServiceQuotaSnapshotV1 | null | undefined): number {
  const fetchedAt = Number(snapshot?.fetchedAt ?? 0);
  return Number.isFinite(fetchedAt) && fetchedAt >= 0 ? fetchedAt : 0;
}

export type ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry = Readonly<{
  snapshot: ConnectedServiceQuotaSnapshotV1;
  verifiedCredentialFingerprint?: string | null;
}>;

type SnapshotCurrentContext = Readonly<{
  context: ProviderAccountUsageOrganizationContext | null;
  verifiedCredentialFingerprint?: string | null;
}>;

function selectFreshestSnapshotEntry(
  first: ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry | null | undefined,
  second: ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry | null | undefined,
  nowMs: number,
): ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry | null {
  if (!first) return second ?? null;
  if (!second) return first;
  return compareConnectedServiceQuotaObservationRecency({
    existingObservedAtMs: readFetchedAt(first.snapshot),
    incomingObservedAtMs: readFetchedAt(second.snapshot),
    nowMs,
  }) === 'incoming_newer' ? second : first;
}

function isSnapshotEntryCurrent(
  entry: ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry,
  current: SnapshotCurrentContext,
): boolean {
  if (entry.snapshot.providerOrganizationId) {
    return isProviderAccountUsageOrganizationContextMatch(entry.snapshot, current.context);
  }
  return Boolean(current.context?.providerAccountId
    && entry.snapshot.activeAccountId === current.context.providerAccountId
    && current.verifiedCredentialFingerprint
    && entry.verifiedCredentialFingerprint === current.verifiedCredentialFingerprint);
}

/**
 * A delivery's provider capture kept for release (spec A.3), with the observation it came from so the
 * same account/organization/credential rules that qualify quota state qualify it (HPI-37).
 */
type CaptureEvidence = Readonly<{
  capturedAtMs: number;
  staleAtMs: number;
  entry: ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry;
  // Whether an authoritative retention (one that proved the member's current account, organization or
  // credential) has accepted this context. Evidence merely preserved through an unavailable credential
  // read is not qualified (HPI-44).
  qualified: boolean;
}>;

/**
 * Whether two observations describe the same provider context. An organization-scoped observation is
 * identified by its organization and account (its token may rotate); an unscoped one by its account
 * and verified credential.
 */
function isSameObservationContext(
  left: ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry,
  right: ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry,
): boolean {
  if ((left.snapshot.activeAccountId ?? null) !== (right.snapshot.activeAccountId ?? null)) return false;
  const leftOrganization = left.snapshot.providerOrganizationId ?? null;
  if (leftOrganization !== (right.snapshot.providerOrganizationId ?? null)) return false;
  if (leftOrganization) return true;
  return (left.verifiedCredentialFingerprint ?? null) === (right.verifiedCredentialFingerprint ?? null);
}

function shouldRecordSnapshot(
  existing: ConnectedServiceQuotaSnapshotV1 | null | undefined,
  incoming: ConnectedServiceQuotaSnapshotV1,
  nowMs: number,
): boolean {
  if (!existing) return true;
  const recency = compareConnectedServiceQuotaObservationRecency({
    existingObservedAtMs: readFetchedAt(existing),
    incomingObservedAtMs: readFetchedAt(incoming),
    nowMs,
  });
  return recency === 'incoming_newer' || recency === 'same';
}

type BurnObservation = Readonly<{
  remainingPct: number;
  atMs: number;
  groupGeneration: number | null;
  effectiveMeterId: string;
  providerLimitId: string | null;
  resetAtMs: number | null;
}>;
type BurnHistory = Readonly<{ prev: BurnObservation | null; latest: BurnObservation }>;

export type ConnectedServiceAuthGroupRuntimeQuotaBurn = Readonly<{
  /** Positive consumption velocity of the effective meter's remaining%, in percent per ms. */
  remainingPercentPerMs: number;
  observedAtMs: number;
  remainingPercent: number;
  groupGeneration: number | null;
  effectiveMeterId: string;
  providerLimitId: string | null;
  resetAtMs: number | null;
}>;

function readBurnObservation(
  snapshot: ConnectedServiceQuotaSnapshotV1,
  groupGeneration: number | null | undefined,
): BurnObservation | null {
  const quotaSnapshot = buildMemberState(snapshot).quotaSnapshot;
  const remainingPct = quotaSnapshot?.effectiveRemainingPercent;
  const effectiveMeterId = quotaSnapshot?.effectiveMeterId;
  if (typeof remainingPct !== 'number' || !Number.isFinite(remainingPct) || !effectiveMeterId) return null;
  const effectiveMeter = quotaSnapshot.meters?.find((meter) => meter.meterId === effectiveMeterId) ?? null;
  return {
    remainingPct,
    atMs: readFetchedAt(snapshot),
    groupGeneration: typeof groupGeneration === 'number' && Number.isFinite(groupGeneration)
      ? Math.max(0, Math.trunc(groupGeneration))
      : null,
    effectiveMeterId,
    providerLimitId: effectiveMeter?.providerLimitId ?? null,
    resetAtMs: effectiveMeter?.resetAtMs ?? null,
  };
}

function isSameBurnContext(left: BurnObservation, right: BurnObservation): boolean {
  return left.groupGeneration === right.groupGeneration
    && left.effectiveMeterId === right.effectiveMeterId
    && left.providerLimitId === right.providerLimitId
    && left.resetAtMs === right.resetAtMs;
}

export class ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore {
  private readonly snapshotsByKey = new Map<string, ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry>();
  private readonly snapshotsByProfileKey = new Map<string, ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry>();
  private readonly burnHistoryByKey = new Map<string, BurnHistory>();
  /**
   * The latest still-fresh provider capture each member's deliveries proved, whether or not their
   * snapshot won quota-state recency. State ordering compares `fetchedAt`, which is receipt time for a
   * live in-band row but capture time for a replayed one; release evidence (spec A.3) is a capture
   * chronology and must not be lost to that ordering (HPI-35).
   */
  // One latest capture per distinct provider context, in arrival order: a delivery from another
  // context must neither qualify for this member's current context nor displace its evidence (HPI-43).
  private readonly latestCapturesByProfileKey = new Map<string, ReadonlyArray<CaptureEvidence>>();

  recordSnapshot(input: SnapshotKeyInput & ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry): void {
    const key = snapshotKey(input);
    const nowMs = Date.now();
    const existing = this.snapshotsByKey.get(key);
    if (shouldRecordSnapshot(existing?.snapshot, input.snapshot, nowMs)) {
      if (existing && (existing.snapshot.providerOrganizationId || input.snapshot.providerOrganizationId
        || existing.verifiedCredentialFingerprint || input.verifiedCredentialFingerprint)
        && !isSnapshotEntryCurrent(existing, {
          context: {
            providerAccountId: input.snapshot.activeAccountId ?? null,
            providerOrganizationId: input.snapshot.providerOrganizationId ?? null,
          },
          verifiedCredentialFingerprint: input.verifiedCredentialFingerprint,
        })) {
        this.burnHistoryByKey.delete(key);
      }
      this.snapshotsByKey.set(key, {
        snapshot: input.snapshot,
        verifiedCredentialFingerprint: input.verifiedCredentialFingerprint,
      });
      this.recordBurnObservation(key, input.snapshot, input.groupGeneration, nowMs);
    }
    this.recordProfileSnapshot(input);
  }

  private recordBurnObservation(
    key: string,
    snapshot: ConnectedServiceQuotaSnapshotV1,
    groupGeneration: number | null | undefined,
    nowMs: number,
  ): void {
    const observation = readBurnObservation(snapshot, groupGeneration);
    if (!observation) return;
    const existing = this.burnHistoryByKey.get(key);
    // Only advance the history when this observation is strictly newer than the latest one; a
    // duplicate/stale fetchedAt would otherwise poison the delta with a zero time window.
    if (existing && compareConnectedServiceQuotaObservationRecency({
      existingObservedAtMs: existing.latest.atMs,
      incomingObservedAtMs: observation.atMs,
      nowMs,
    }) !== 'incoming_newer') return;
    this.burnHistoryByKey.set(key, {
      prev: existing && isSameBurnContext(existing.latest, observation) ? existing.latest : null,
      latest: observation,
    });
  }

  /**
   * Recent consumption velocity of the effective meter's remaining% for a member, derived from the
   * two most recent distinct-time in-band snapshots this store retained. Only a DECREASING remaining%
   * (real burn) yields a value; a flat or increasing remaining% (a reset/replenish) returns null so
   * the predictive projection fails closed. This is the fast-burn signal the poll-driven soft-switch
   * cannot see between 30-minute quota polls.
   */
  getRecentBurn(input: SnapshotKeyInput & Readonly<{
    nowMs?: number;
    maxAgeMs?: number;
    currentQuotaSnapshot?: ConnectedServiceAuthGroupMemberRuntimeState['quotaSnapshot'];
  }>): ConnectedServiceAuthGroupRuntimeQuotaBurn | null {
    const history = this.burnHistoryByKey.get(snapshotKey(input));
    if (!history || !history.prev) return null;
    if (
      typeof input.groupGeneration === 'number'
      && history.latest.groupGeneration !== Math.max(0, Math.trunc(input.groupGeneration))
    ) return null;
    if (typeof input.nowMs === 'number' && typeof input.maxAgeMs === 'number') {
      const ageMs = input.nowMs - history.latest.atMs;
      if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > Math.max(0, input.maxAgeMs)) return null;
    }
    if (
      typeof input.nowMs === 'number'
      && Number.isFinite(input.nowMs)
      && typeof history.latest.resetAtMs === 'number'
      && Number.isFinite(history.latest.resetAtMs)
      && input.nowMs >= history.latest.resetAtMs
    ) return null;
    const currentQuotaSnapshot = input.currentQuotaSnapshot;
    if (currentQuotaSnapshot) {
      if (history.latest.atMs !== currentQuotaSnapshot.capturedAtMs) return null;
      if (history.latest.remainingPct !== currentQuotaSnapshot.effectiveRemainingPercent) return null;
      if (history.latest.effectiveMeterId !== currentQuotaSnapshot.effectiveMeterId) return null;
      const currentMeter = currentQuotaSnapshot.meters?.find(
        (meter) => meter.meterId === currentQuotaSnapshot.effectiveMeterId,
      ) ?? null;
      if (
        history.latest.providerLimitId !== (currentMeter?.providerLimitId ?? null)
        || history.latest.resetAtMs !== (currentMeter?.resetAtMs ?? null)
      ) return null;
    }
    const deltaRemaining = history.prev.remainingPct - history.latest.remainingPct;
    const deltaMs = history.latest.atMs - history.prev.atMs;
    if (deltaRemaining <= 0 || deltaMs <= 0) return null;
    return {
      remainingPercentPerMs: deltaRemaining / deltaMs,
      observedAtMs: history.latest.atMs,
      remainingPercent: history.latest.remainingPct,
      groupGeneration: history.latest.groupGeneration,
      effectiveMeterId: history.latest.effectiveMeterId,
      providerLimitId: history.latest.providerLimitId,
      resetAtMs: history.latest.resetAtMs,
    };
  }

  recordProfileSnapshot(input: ProfileSnapshotKeyInput & ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry): void {
    const key = profileSnapshotKey(input);
    this.recordCaptureEvidence(input, Date.now());
    if (shouldRecordSnapshot(this.snapshotsByProfileKey.get(key)?.snapshot, input.snapshot, Date.now())) {
      this.snapshotsByProfileKey.set(key, {
        snapshot: input.snapshot,
        verifiedCredentialFingerprint: input.verifiedCredentialFingerprint,
      });
    }
  }

  retainProfileSnapshots(input: ProfileSnapshotKeyInput & SnapshotCurrentContext): void {
    const shouldRetainEntry = (entry: ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry): boolean => {
      if (!entry.snapshot.providerOrganizationId && input.verifiedCredentialFingerprint === undefined) {
        // An unavailable credential read preserves verified bytes; reuse still requires current user/token proof.
        return Boolean(entry.verifiedCredentialFingerprint
          && (!input.context?.providerAccountId || entry.snapshot.activeAccountId === input.context.providerAccountId));
      }
      return isSnapshotEntryCurrent(entry, input);
    };
    const isAuthoritativeFor = (entry: ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry): boolean =>
      Boolean(entry.snapshot.providerOrganizationId) || input.verifiedCredentialFingerprint !== undefined;
    const profileKey = profileSnapshotKey(input);
    const profileEntry = this.snapshotsByProfileKey.get(profileKey);
    if (profileEntry && !shouldRetainEntry(profileEntry)) {
      this.snapshotsByProfileKey.delete(profileKey);
    }
    const servicePrefix = `${input.serviceId}\0`;
    const profileSuffix = `\0${input.profileId}`;
    for (const [key, entry] of this.snapshotsByKey) {
      if (!key.startsWith(servicePrefix) || !key.endsWith(profileSuffix)) continue;
      if (shouldRetainEntry(entry)) continue;
      this.snapshotsByKey.delete(key);
      this.burnHistoryByKey.delete(key);
    }
    // Capture evidence is qualified by the same rule, whether or not its snapshot won state ordering.
    const evidence = this.latestCapturesByProfileKey.get(profileKey);
    if (evidence) {
      const retained = evidence
        .filter((item) => shouldRetainEntry(item.entry))
        .map((item) => (item.qualified || !isAuthoritativeFor(item.entry) ? item : { ...item, qualified: true }));
      if (retained.length === 0) this.latestCapturesByProfileKey.delete(profileKey);
      else this.latestCapturesByProfileKey.set(profileKey, retained);
    }
  }

  private recordCaptureEvidence(input: ProfileSnapshotKeyInput & ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry, nowMs: number): void {
    const capturedAtMs = resolveFreshQuotaSnapshotCapturedAtOrAfterMs(input.snapshot, nowMs);
    if (capturedAtMs === null) return;
    const fetchedAt = input.snapshot.fetchedAtMs ?? input.snapshot.fetchedAt;
    const staleAtMs = input.snapshot.staleAtMs ?? fetchedAt + input.snapshot.staleAfterMs;
    const key = profileSnapshotKey(input);
    const entry = { snapshot: input.snapshot, verifiedCredentialFingerprint: input.verifiedCredentialFingerprint };
    const fresh = (this.latestCapturesByProfileKey.get(key) ?? []).filter((item) => nowMs < item.staleAtMs);
    const sameContext = fresh.find((item) => isSameObservationContext(item.entry, entry));
    // Within one context the later capture wins; other contexts' evidence is left untouched.
    if (sameContext && sameContext.capturedAtMs > capturedAtMs) {
      this.latestCapturesByProfileKey.set(key, fresh);
      return;
    }
    // A later capture of an accepted context stays accepted: the same context passes the same retention.
    this.latestCapturesByProfileKey.set(key, [...fresh.filter((item) => item !== sameContext),
      { capturedAtMs, staleAtMs, entry, qualified: sameContext?.qualified ?? false }]);
  }

  /**
   * The latest provider capture still fresh at `nowMs` for a member: from its current quota state or
   * from a later-captured delivery that state ordering did not keep, counted only when it describes
   * the same provider context as that current state (HPI-37); null when none is fresh.
   */
  readFreshCaptureAtOrAfterMs(input: ProfileSnapshotKeyInput & Readonly<{ groupId?: string; nowMs: number }>): number | null {
    const entry = this.getSnapshotEntry(input);
    const fromState = entry ? resolveFreshQuotaSnapshotCapturedAtOrAfterMs(entry.snapshot, input.nowMs) : null;
    const fresh = (this.latestCapturesByProfileKey.get(profileSnapshotKey(input)) ?? [])
      .filter((item) => input.nowMs < item.staleAtMs);
    const fromEvidence = entry
      // With current state, only evidence from its context counts.
      ? fresh.find((item) => isSameObservationContext(item.entry, entry))?.capturedAtMs ?? null
      : this.readAbsentStateCapture(fresh);
    if (fromState === null) return fromEvidence;
    return fromEvidence === null ? fromState : Math.max(fromState, fromEvidence);
  }

  /**
   * Without current quota state: the latest capture among contexts an authoritative retention accepted
   * for the member, all of which describe its current account (HPI-44); if none was accepted, only the
   * latest-arriving context, never the greatest capture across unqualified contexts.
   */
  private readAbsentStateCapture(fresh: ReadonlyArray<CaptureEvidence>): number | null {
    const qualified = fresh.filter((item) => item.qualified);
    if (qualified.length > 0) return Math.max(...qualified.map((item) => item.capturedAtMs));
    return fresh.at(-1)?.capturedAtMs ?? null;
  }

  getSnapshotEntry(input: ProfileSnapshotKeyInput & Readonly<{ groupId?: string }>): ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry | null {
    return selectFreshestSnapshotEntry(
      input.groupId === undefined ? null : this.snapshotsByKey.get(snapshotKey({ ...input, groupId: input.groupId })),
      this.snapshotsByProfileKey.get(profileSnapshotKey(input)),
      Date.now(),
    );
  }

  getSnapshot(input: SnapshotKeyInput): ConnectedServiceQuotaSnapshotV1 | null {
    return this.getSnapshotEntry(input)?.snapshot ?? null;
  }

  buildMemberStates(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    capturedAtMs: number;
    quotaLimitSelection?: ConnectedServiceAuthGroupQuotaLimitSelectionV1;
  }>): Map<string, ConnectedServiceAuthGroupMemberRuntimeState> {
    void input.capturedAtMs;
    const states = new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>();
    const prefix = `${input.serviceId}\0${input.groupId}\0`;
    for (const [key, entry] of this.snapshotsByKey.entries()) {
      if (!key.startsWith(prefix)) continue;
      const profileId = key.slice(prefix.length);
      const profileSnapshot = this.snapshotsByProfileKey.get(profileSnapshotKey({ serviceId: input.serviceId, profileId }));
      states.set(profileId, buildMemberState(
        (selectFreshestSnapshotEntry(entry, profileSnapshot, input.capturedAtMs) ?? entry).snapshot,
        input.quotaLimitSelection,
      ));
    }
    const profilePrefix = `${input.serviceId}\0`;
    for (const [key, { snapshot }] of this.snapshotsByProfileKey.entries()) {
      if (!key.startsWith(profilePrefix)) continue;
      const profileId = key.slice(profilePrefix.length);
      if (states.has(profileId)) continue;
      states.set(profileId, buildMemberState(snapshot, input.quotaLimitSelection));
    }
    return states;
  }
}

function buildMemberState(
  snapshot: ConnectedServiceQuotaSnapshotV1,
  quotaLimitSelection?: ConnectedServiceAuthGroupQuotaLimitSelectionV1,
): ConnectedServiceAuthGroupMemberRuntimeState {
  return buildConnectedServiceAuthGroupRuntimeStateFromMeters({
    capturedAtMs: snapshot.fetchedAt,
    meters: snapshot.meters,
    subscription: snapshot.subscription,
    selection: quotaLimitSelection,
  });
}
