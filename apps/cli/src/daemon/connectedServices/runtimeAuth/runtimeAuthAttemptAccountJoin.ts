import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

/**
 * Join of each ordinary-group runtime-auth recovery attempt (`runtime-auth-attempt:*`) to the
 * provider-observed account that actually served the session afterwards.
 *
 * States are kept distinct and are never inferred from one another:
 * - requested:    the recovery scheduler admitted the attempt for a failed member;
 * - selected:     the attempt recorded a target member/generation (`pendingTargetProfileId`);
 * - applied:      each `resumed_awaiting_proof` settlement is one application interval. Its exact
 *                 application instant is NOT witnessed: the switch happened after the attempt's
 *                 previous persisted transition (`windowStartMs`) and before the resumed status was
 *                 persisted (`persistedAtMs`). Observations inside that window are reported as
 *                 boundary-uncertain rather than assigned to either account;
 * - observed:     the provider's own transcript identified the serving account, resolved to a
 *                 member only when that identity is unique in the pool, and adopted by the
 *                 application owner only after its registry/native currentness recheck;
 * - recovered:    the scheduler settled the attempt `recovered`, with the proof kind(s) offered;
 * - useful:       only a `provider_activity` proof for this attempt, after a witnessed application,
 *                 from the session's exact current turn. Activity whose turn was not verified is
 *                 reported as such. Quota freshness recovers an attempt but is never useful evidence.
 * Materialization is not separately evidenced by the scheduler and is reported as such.
 *
 * Times: `persistedAtMs` is daemon wall-clock after durable persistence; `observedAtMs` is the
 * provider transcript's own timestamp. They measure different boundaries, so the fold never
 * resolves an observation that falls between an attempt's window start and its persistence.
 *
 * The journal is append-only: every transition, observation and proof is retained, including
 * stale, ambiguous, rejected and superseded ones, so mismatch/unknown/retry histories stay inspectable.
 */

export const RUNTIME_AUTH_ATTEMPT_ACCOUNT_JOIN_EVENT_VERSION = 1;

const NullableString = z.string().min(1).nullable();

const AttemptTransitionEventSchema = z.object({
  v: z.literal(1),
  kind: z.literal('attempt_transition'),
  attemptId: z.string().min(1),
  sessionId: z.string().min(1),
  serviceId: z.string().min(1),
  groupId: NullableString,
  /** The member the failed request ran as, per the scheduler's classification. */
  failedProfileId: NullableString,
  status: z.string().min(1),
  transition: z.string().min(1),
  targetProfileId: NullableString,
  targetGeneration: z.number().int().nonnegative().nullable(),
  failureKind: NullableString,
  /** Provider transcript identity of the FAILED request, verbatim; null means unproven. */
  failedRequestProviderOrganizationId: NullableString,
  sourceKey: NullableString,
  runtimeIssueFingerprint: NullableString,
  attemptCount: z.number().int().nonnegative(),
  terminalReason: NullableString,
  /** Daemon wall-clock taken after this transition was durably persisted; not an effect time. */
  persistedAtMs: z.number().int().nonnegative(),
}).strict();

const ProviderAccountResolutionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unique_member'), profileId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('ambiguous'), matchingProfileIds: z.array(z.string().min(1)) }).strict(),
  z.object({ kind: z.literal('unproven'), reason: z.string().min(1) }).strict(),
]);

export type ProviderAccountResolution = z.infer<typeof ProviderAccountResolutionSchema>;

const ProviderAccountObservedEventSchema = z.object({
  v: z.literal(1),
  kind: z.literal('provider_account_observed'),
  sessionId: z.string().min(1),
  serviceId: z.string().min(1),
  groupId: z.string().min(1),
  /** The provider-native session the observation came from. */
  nativeSessionId: z.string().min(1),
  providerOrganizationId: NullableString,
  resolution: ProviderAccountResolutionSchema,
  /** The application owner's decision after its currentness recheck; only `adopted` can count. */
  adoption: z.enum(['adopted', 'not_unique_member', 'rejected_not_current', 'rejected_by_registry']),
  observedAtMs: z.number().int().nonnegative(),
}).strict();

const ProviderOutcomeProofEventSchema = z.object({
  v: z.literal(1),
  kind: z.literal('provider_outcome_proof'),
  sessionId: z.string().min(1),
  /** The attempt current when the proof was offered (null when no intent existed). */
  attemptId: NullableString,
  expectedAttemptId: NullableString,
  proofKind: z.string().min(1),
  /** Provider-side time of the proven activity, when the caller supplied one. */
  observedAtMs: z.number().int().nonnegative().nullable(),
  /**
   * Producer-stated turn ownership of provider activity: `exact_turn` only when the exact-turn
   * owner matched the session's current turn; null when the producer did not state it.
   */
  turnOwnership: z.enum(['exact_turn', 'unverified_turn']).nullable(),
  statusBefore: NullableString,
  statusAfter: NullableString,
  attemptIdAfter: NullableString,
  persistedAtMs: z.number().int().nonnegative(),
}).strict();

export const RuntimeAuthAttemptAccountJoinEventSchema = z.discriminatedUnion('kind', [
  AttemptTransitionEventSchema,
  ProviderAccountObservedEventSchema,
  ProviderOutcomeProofEventSchema,
]);

export type RuntimeAuthAttemptTransitionEvent = z.infer<typeof AttemptTransitionEventSchema>;
export type ProviderAccountObservedEvent = z.infer<typeof ProviderAccountObservedEventSchema>;
export type ProviderOutcomeProofEvent = z.infer<typeof ProviderOutcomeProofEventSchema>;
export type RuntimeAuthAttemptAccountJoinEvent = z.infer<typeof RuntimeAuthAttemptAccountJoinEventSchema>;

export type AttemptObservationDisposition =
  /** After one of this attempt's applications was persisted, and no later application had begun. */
  | 'counted'
  /** Inside an application window of this attempt: either the previous or the new account. */
  | 'boundary_uncertain'
  /** Before this attempt's first application window: it describes an earlier account. */
  | 'before_application'
  /** A later application (of another attempt) covers this observation. */
  | 'superseded_by_newer_attempt'
  /** Another attempt's application window starts at the same instant: no exclusive association. */
  | 'ambiguous_attempt_tie'
  /** The application owner did not adopt it (not unique, not current, or registry-rejected). */
  | 'not_adopted';

export type RuntimeAuthAttemptAccountVerdict =
  | 'awaiting_selection'
  | 'awaiting_application'
  | 'applied_awaiting_observation'
  | 'boundary_uncertain'
  | 'confirmed'
  | 'mismatch'
  /** Counted observations from different native sessions disagree; no native witness decides. */
  | 'conflicting_native_sessions'
  | 'unknown'
  | 'ended_unapplied';

export type RuntimeAuthAttemptApplication = Readonly<{
  index: number;
  profileId: string | null;
  generation: number | null;
  /** The switch cannot have begun before this (the attempt's previous persisted transition). */
  windowStartMs: number;
  /** The switch had completed by this (resumed status persisted). */
  persistedAtMs: number;
  countedNativeSessionIds: ReadonlyArray<string>;
  verdict: Exclude<RuntimeAuthAttemptAccountVerdict, 'awaiting_selection' | 'awaiting_application' | 'ended_unapplied'>;
}>;

export type RuntimeAuthAttemptUsefulContinuation =
  | Readonly<{ kind: 'provider_activity'; observedAtMs: number; applicationIndex: number }>
  /** Post-application activity for this attempt whose turn ownership was not verified. */
  | Readonly<{ kind: 'provider_activity_unverified_turn'; observedAtMs: number; applicationIndex: number }>
  | Readonly<{ kind: 'boundary_uncertain'; observedAtMs: number | null; applicationIndex: number | null }>
  | Readonly<{ kind: 'not_witnessed' }>;

export type RuntimeAuthAttemptAccountJoin = Readonly<{
  attemptId: string;
  sessionId: string;
  serviceId: string;
  groupId: string | null;
  requested: Readonly<{ persistedAtMs: number; failedProfileId: string | null; failureKind: string | null;
    failedRequestProviderOrganizationId: string | null; sourceKey: string | null; runtimeIssueFingerprint: string | null }>;
  /** Every distinct target the attempt selected, in order (a retry may select again). */
  selected: ReadonlyArray<Readonly<{ profileId: string; generation: number | null; persistedAtMs: number }>>;
  materialized: 'not_separately_evidenced';
  /** Every application interval, in order; earlier ones are history, never rewritten. */
  applications: ReadonlyArray<RuntimeAuthAttemptApplication>;
  observations: ReadonlyArray<Readonly<{
    event: ProviderAccountObservedEvent;
    disposition: AttemptObservationDisposition;
    applicationIndex: number | null;
  }>>;
  /** The scheduler settled `recovered`; proof kinds that produced it, or 'not_recorded'. */
  schedulerRecovered: Readonly<{ persistedAtMs: number; proofKinds: ReadonlyArray<string> | 'not_recorded' }> | null;
  usefulContinuation: RuntimeAuthAttemptUsefulContinuation;
  proofs: ReadonlyArray<ProviderOutcomeProofEvent>;
  /** First terminal status reached; `latestStatus` is the attempt's current status. */
  firstTerminal: Readonly<{ status: string; reason: string | null; persistedAtMs: number }> | null;
  latestStatus: string;
  transitions: ReadonlyArray<RuntimeAuthAttemptTransitionEvent>;
  /** The latest application's verdict, or the pre-application state. */
  verdict: RuntimeAuthAttemptAccountVerdict;
}>;

const TERMINAL_STATUSES = new Set(['recovered', 'exhausted', 'cancelled']);

type Interval = {
  attemptId: string;
  index: number;
  profileId: string | null;
  generation: number | null;
  windowStartMs: number;
  persistedAtMs: number;
};

type SessionAttribution =
  | { kind: 'none' }
  | { kind: 'certain'; interval: Interval }
  | { kind: 'window'; interval: Interval }
  | { kind: 'tie'; intervals: ReadonlyArray<Interval> };

function attributeObservation(intervals: ReadonlyArray<Interval>, observedAtMs: number): SessionAttribution {
  const started = intervals.filter((interval) => interval.windowStartMs <= observedAtMs);
  if (started.length === 0) return { kind: 'none' };
  const latestStart = Math.max(...started.map((interval) => interval.windowStartMs));
  const latest = started.filter((interval) => interval.windowStartMs === latestStart);
  const latestAttempts = new Set(latest.map((interval) => interval.attemptId));
  if (latestAttempts.size > 1) return { kind: 'tie', intervals: latest };
  const interval = latest.reduce((a, b) => (b.index > a.index ? b : a));
  return observedAtMs >= interval.persistedAtMs ? { kind: 'certain', interval } : { kind: 'window', interval };
}

/** Folds the journal into one view per attempt. Pure and independent of observation arrival order. */
export function foldRuntimeAuthAttemptAccountJoins(
  events: ReadonlyArray<RuntimeAuthAttemptAccountJoinEvent>,
): ReadonlyArray<RuntimeAuthAttemptAccountJoin> {
  type Draft = {
    first: RuntimeAuthAttemptTransitionEvent;
    transitions: RuntimeAuthAttemptTransitionEvent[];
    selected: Array<{ profileId: string; generation: number | null; persistedAtMs: number }>;
    intervals: Interval[];
    recoveredAtMs: number | null;
    firstTerminal: { status: string; reason: string | null; persistedAtMs: number } | null;
  };
  const drafts = new Map<string, Draft>();
  for (const event of events) {
    if (event.kind !== 'attempt_transition') continue;
    let draft = drafts.get(event.attemptId);
    if (!draft) {
      draft = { first: event, transitions: [], selected: [], intervals: [], recoveredAtMs: null, firstTerminal: null };
      drafts.set(event.attemptId, draft);
    }
    const previous = draft.transitions[draft.transitions.length - 1] ?? null;
    draft.transitions.push(event);
    const lastSelected = draft.selected[draft.selected.length - 1];
    if (event.targetProfileId && (lastSelected?.profileId !== event.targetProfileId || lastSelected.generation !== event.targetGeneration)) {
      draft.selected.push({ profileId: event.targetProfileId, generation: event.targetGeneration, persistedAtMs: event.persistedAtMs });
    }
    if (event.status === 'resumed_awaiting_proof') {
      const lastInterval = draft.intervals[draft.intervals.length - 1];
      const sameApplication = previous?.status === 'resumed_awaiting_proof' && lastInterval
        && lastInterval.profileId === event.targetProfileId && lastInterval.generation === event.targetGeneration;
      if (!sameApplication) {
        draft.intervals.push({
          attemptId: event.attemptId,
          index: draft.intervals.length,
          profileId: event.targetProfileId,
          generation: event.targetGeneration,
          windowStartMs: Math.min(previous?.persistedAtMs ?? event.persistedAtMs, event.persistedAtMs),
          persistedAtMs: event.persistedAtMs,
        });
      }
    }
    if (event.status === 'recovered' && draft.recoveredAtMs === null) draft.recoveredAtMs = event.persistedAtMs;
    if (TERMINAL_STATUSES.has(event.status) && !draft.firstTerminal) {
      draft.firstTerminal = { status: event.status, reason: event.terminalReason, persistedAtMs: event.persistedAtMs };
    }
  }

  const sessionKey = (sessionId: string, serviceId: string, groupId: string | null) => JSON.stringify([sessionId, serviceId, groupId]);
  const intervalsBySession = new Map<string, Interval[]>();
  for (const draft of drafts.values()) {
    const key = sessionKey(draft.first.sessionId, draft.first.serviceId, draft.first.groupId);
    intervalsBySession.set(key, [...(intervalsBySession.get(key) ?? []), ...draft.intervals]);
  }
  const observations = events.filter((event): event is ProviderAccountObservedEvent => event.kind === 'provider_account_observed');
  const proofs = events.filter((event): event is ProviderOutcomeProofEvent => event.kind === 'provider_outcome_proof');

  return [...drafts.entries()].map(([attemptId, draft]) => {
    const first = draft.first;
    const sessionIntervals = intervalsBySession.get(sessionKey(first.sessionId, first.serviceId, first.groupId)) ?? [];
    const own = (interval: Interval) => interval.attemptId === attemptId;
    const ownStartedBefore = (observedAtMs: number) => draft.intervals.some((interval) => interval.windowStartMs <= observedAtMs);
    const classified = observations
      .filter((event) => event.sessionId === first.sessionId && event.serviceId === first.serviceId && event.groupId === first.groupId)
      .map((event) => {
        const outside = (): { disposition: AttemptObservationDisposition; applicationIndex: number | null } => (
          ownStartedBefore(event.observedAtMs)
            ? { disposition: 'superseded_by_newer_attempt', applicationIndex: null }
            : { disposition: 'before_application', applicationIndex: null }
        );
        let result: { disposition: AttemptObservationDisposition; applicationIndex: number | null };
        if (event.adoption !== 'adopted') {
          result = { disposition: 'not_adopted', applicationIndex: null };
        } else {
          const attribution = attributeObservation(sessionIntervals, event.observedAtMs);
          if (attribution.kind === 'none') result = { disposition: 'before_application', applicationIndex: null };
          else if (attribution.kind === 'tie') {
            const mine = attribution.intervals.filter(own);
            result = mine.length > 0
              ? { disposition: 'ambiguous_attempt_tie', applicationIndex: mine[mine.length - 1]!.index }
              : outside();
          } else if (own(attribution.interval)) {
            result = {
              disposition: attribution.kind === 'certain' ? 'counted' : 'boundary_uncertain',
              applicationIndex: attribution.interval.index,
            };
          } else if (attribution.kind === 'window' && ownStartedBefore(event.observedAtMs)) {
            // Inside another attempt's application window: it may still be this attempt's account.
            const latestOwn = draft.intervals.filter((interval) => interval.windowStartMs <= event.observedAtMs).pop()!;
            result = { disposition: 'boundary_uncertain', applicationIndex: latestOwn.index };
          } else {
            result = outside();
          }
        }
        return { event, ...result };
      });

    const applications: RuntimeAuthAttemptApplication[] = draft.intervals.map((interval) => {
      const counted = classified.filter((entry) => entry.disposition === 'counted' && entry.applicationIndex === interval.index);
      const uncertain = classified.some((entry) => entry.applicationIndex === interval.index
        && (entry.disposition === 'boundary_uncertain' || entry.disposition === 'ambiguous_attempt_tie'));
      return {
        index: interval.index,
        profileId: interval.profileId,
        generation: interval.generation,
        windowStartMs: interval.windowStartMs,
        persistedAtMs: interval.persistedAtMs,
        countedNativeSessionIds: [...new Set(counted.map((entry) => entry.event.nativeSessionId))].sort(),
        verdict: resolveApplicationVerdict({ profileId: interval.profileId, counted: counted.map((entry) => entry.event), uncertain }),
      };
    });

    const attemptProofs = proofs.filter((proof) => proof.sessionId === first.sessionId && proof.attemptId === attemptId
      && (proof.expectedAttemptId === null || proof.expectedAttemptId === attemptId));
    const recoveringProofKinds = attemptProofs
      .filter((proof) => proof.statusAfter === 'recovered' && proof.statusBefore !== 'recovered')
      .map((proof) => proof.proofKind);
    const latestStatus = draft.transitions[draft.transitions.length - 1]!.status;
    return {
      attemptId,
      sessionId: first.sessionId,
      serviceId: first.serviceId,
      groupId: first.groupId,
      requested: {
        persistedAtMs: first.persistedAtMs,
        failedProfileId: first.failedProfileId,
        failureKind: first.failureKind,
        failedRequestProviderOrganizationId: first.failedRequestProviderOrganizationId,
        sourceKey: first.sourceKey,
        runtimeIssueFingerprint: first.runtimeIssueFingerprint,
      },
      selected: draft.selected,
      materialized: 'not_separately_evidenced' as const,
      applications,
      observations: classified,
      schedulerRecovered: draft.recoveredAtMs === null ? null : {
        persistedAtMs: draft.recoveredAtMs,
        proofKinds: recoveringProofKinds.length > 0 ? [...new Set(recoveringProofKinds)] : 'not_recorded' as const,
      },
      usefulContinuation: resolveUsefulContinuation({ intervals: draft.intervals, sessionIntervals, proofs: attemptProofs, attemptId }),
      proofs: attemptProofs,
      firstTerminal: draft.firstTerminal,
      latestStatus,
      transitions: draft.transitions,
      verdict: applications.length > 0
        ? applications[applications.length - 1]!.verdict
        : draft.firstTerminal
          ? 'ended_unapplied'
          : draft.selected.length > 0 ? 'awaiting_application' : 'awaiting_selection',
    };
  });
}

function resolveApplicationVerdict(input: Readonly<{
  profileId: string | null;
  counted: ReadonlyArray<ProviderAccountObservedEvent>;
  uncertain: boolean;
}>): RuntimeAuthAttemptApplication['verdict'] {
  if (input.counted.length === 0) return input.uncertain ? 'boundary_uncertain' : 'applied_awaiting_observation';
  // Without a known applied target there is nothing to confirm or contradict.
  if (input.profileId === null) return 'unknown';
  const resolutions = input.counted.map((event) => event.resolution);
  const matches = (resolution: ProviderAccountResolution) => resolution.kind === 'unique_member' && resolution.profileId === input.profileId;
  const contradicts = (resolution: ProviderAccountResolution) => resolution.kind === 'unique_member' && resolution.profileId !== input.profileId;
  if (resolutions.some(contradicts)) {
    // No application-owned native witness exists: disagreeing native sessions stay unresolved.
    const natives = new Set(input.counted.map((event) => event.nativeSessionId));
    return natives.size > 1 && resolutions.some(matches) ? 'conflicting_native_sessions' : 'mismatch';
  }
  return resolutions.every(matches) ? 'confirmed' : 'unknown';
}

function resolveUsefulContinuation(input: Readonly<{
  intervals: ReadonlyArray<Interval>;
  sessionIntervals: ReadonlyArray<Interval>;
  proofs: ReadonlyArray<ProviderOutcomeProofEvent>;
  attemptId: string;
}>): RuntimeAuthAttemptUsefulContinuation {
  let uncertain: RuntimeAuthAttemptUsefulContinuation | null = null;
  let unverified: RuntimeAuthAttemptUsefulContinuation | null = null;
  for (const proof of input.proofs) {
    if (proof.proofKind !== 'provider_activity') continue;
    if (proof.observedAtMs === null) {
      uncertain ??= { kind: 'boundary_uncertain', observedAtMs: null, applicationIndex: null };
      continue;
    }
    const attribution = attributeObservation(input.sessionIntervals, proof.observedAtMs);
    if (attribution.kind === 'certain' && attribution.interval.attemptId === input.attemptId) {
      if (proof.turnOwnership === 'exact_turn') {
        return { kind: 'provider_activity', observedAtMs: proof.observedAtMs, applicationIndex: attribution.interval.index };
      }
      unverified ??= { kind: 'provider_activity_unverified_turn', observedAtMs: proof.observedAtMs, applicationIndex: attribution.interval.index };
      continue;
    }
    if ((attribution.kind === 'window' && attribution.interval.attemptId === input.attemptId)
      || (attribution.kind === 'tie' && attribution.intervals.some((interval) => interval.attemptId === input.attemptId))) {
      uncertain ??= { kind: 'boundary_uncertain', observedAtMs: proof.observedAtMs, applicationIndex: null };
    }
  }
  return unverified ?? uncertain ?? { kind: 'not_witnessed' };
}

export type RuntimeAuthAttemptAccountJoinRead = Readonly<{
  events: ReadonlyArray<RuntimeAuthAttemptAccountJoinEvent>;
  /** Lines that could not be parsed (for example a torn final append); never silently dropped. */
  invalidLines: ReadonlyArray<Readonly<{ lineNumber: number; error: string }>>;
}>;

export type RuntimeAuthAttemptAccountJoinJournal = Readonly<{
  append(event: RuntimeAuthAttemptAccountJoinEvent): Promise<void>;
  read(): Promise<RuntimeAuthAttemptAccountJoinRead>;
}>;

export function createRuntimeAuthAttemptAccountJoinJournal(input: Readonly<{ filePath: string }>): RuntimeAuthAttemptAccountJoinJournal {
  // One daemon appends; serialize its own appends so lines never interleave.
  let tail: Promise<void> = Promise.resolve();
  return {
    async append(event) {
      const line = `${JSON.stringify(RuntimeAuthAttemptAccountJoinEventSchema.parse(event))}\n`;
      const next = tail.then(async () => {
        await mkdir(dirname(input.filePath), { recursive: true });
        await appendFile(input.filePath, line, { mode: 0o600 });
      });
      tail = next.catch(() => {});
      await next;
    },
    async read() {
      let raw: string;
      try {
        raw = await readFile(input.filePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { events: [], invalidLines: [] };
        throw error;
      }
      const events: RuntimeAuthAttemptAccountJoinEvent[] = [];
      const invalidLines: Array<{ lineNumber: number; error: string }> = [];
      raw.split('\n').forEach((line, index) => {
        if (line.length === 0) return;
        try {
          const parsed = RuntimeAuthAttemptAccountJoinEventSchema.safeParse(JSON.parse(line));
          if (parsed.success) events.push(parsed.data);
          else invalidLines.push({ lineNumber: index + 1, error: parsed.error.issues.map((issue) => issue.message).join('; ') });
        } catch (error) {
          invalidLines.push({ lineNumber: index + 1, error: (error as Error)?.message ?? String(error) });
        }
      });
      return { events, invalidLines };
    },
  };
}

/** Projects one scheduler delivery into a journal transition event. */
export function buildRuntimeAuthAttemptTransitionEvent(input: Readonly<{
  attemptId: string;
  transition: string;
  persistedAtMs: number;
  intent: Readonly<{
    sessionId: string;
    serviceId: string;
    groupId: string | null;
    profileId: string | null;
    status: string;
    attemptCount: number;
    pendingTargetProfileId?: string | null;
    pendingTargetGeneration?: number | null;
    terminalReason?: string | null;
    classification: Readonly<{
      kind: string;
      providerReportedOrganizationId?: string | null;
      sourceKey?: string | null;
      runtimeIssueFingerprint?: string | null;
    }>;
  }>;
}>): RuntimeAuthAttemptTransitionEvent {
  const text = (value: string | null | undefined): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
  const generation = input.intent.pendingTargetGeneration;
  return {
    v: 1,
    kind: 'attempt_transition',
    attemptId: input.attemptId,
    sessionId: input.intent.sessionId,
    serviceId: input.intent.serviceId,
    groupId: text(input.intent.groupId),
    failedProfileId: text(input.intent.profileId),
    status: input.intent.status,
    transition: input.transition,
    targetProfileId: text(input.intent.pendingTargetProfileId),
    targetGeneration: typeof generation === 'number' && Number.isInteger(generation) && generation >= 0 ? generation : null,
    failureKind: text(input.intent.classification.kind),
    failedRequestProviderOrganizationId: text(input.intent.classification.providerReportedOrganizationId),
    sourceKey: text(input.intent.classification.sourceKey),
    runtimeIssueFingerprint: text(input.intent.classification.runtimeIssueFingerprint),
    attemptCount: Math.max(0, Math.trunc(input.intent.attemptCount)),
    terminalReason: text(input.intent.terminalReason),
    persistedAtMs: Math.max(0, Math.trunc(input.persistedAtMs)),
  };
}

type AttemptIntentShape = Parameters<typeof buildRuntimeAuthAttemptTransitionEvent>[0]['intent'] & Readonly<{ attemptId?: string }>;

function isAttemptLevelChange(before: AttemptIntentShape | null, after: AttemptIntentShape): boolean {
  return !before
    || before.attemptId !== after.attemptId
    || before.status !== after.status
    || (before.pendingTargetProfileId ?? null) !== (after.pendingTargetProfileId ?? null)
    || (before.pendingTargetGeneration ?? null) !== (after.pendingTargetGeneration ?? null);
}

/**
 * Decorates the scheduler's durable store so every committed attempt-level change (new attempt,
 * status, selected target) is reported exactly as persisted. All mutations go through `transact`
 * with the file store's own write/merge/remove semantics, so no path can bypass the report.
 */
export function observeRuntimeAuthRecoveryIntentTransitions<TIntent extends AttemptIntentShape, TStore extends Readonly<{
  read: (recoveryKey: string) => unknown | null;
  transact: <TResult>(recoveryKey: string, transaction: (current: Readonly<{ intent: TIntent | null; effectClaimToken: string | null }>) => Readonly<{
    intent: TIntent | null; effectClaimToken: string | null; result: TResult;
  }>) => Promise<TResult> | TResult;
}>>(store: TStore, onCommitted: (change: Readonly<{ before: TIntent | null; after: TIntent }>) => void): TStore {
  const transact = async <TResult>(
    recoveryKey: string,
    transaction: (current: Readonly<{ intent: TIntent | null; effectClaimToken: string | null }>) => Readonly<{
      intent: TIntent | null; effectClaimToken: string | null; result: TResult;
    }>,
  ): Promise<TResult> => {
    let change: { before: TIntent | null; after: TIntent } | null = null;
    const result = await store.transact<TResult>(recoveryKey, (current) => {
      const next = transaction(current);
      change = next.intent && typeof next.intent.attemptId === 'string' && isAttemptLevelChange(current.intent, next.intent)
        ? { before: current.intent, after: next.intent }
        : null;
      return next;
    });
    if (change) onCommitted(change);
    return result;
  };
  return {
    ...store,
    transact,
    write: async (recoveryKey: string, intent: TIntent) => {
      await transact(recoveryKey, (current) => ({ intent, effectClaimToken: current.effectClaimToken, result: undefined }));
    },
    merge: async (recoveryKey: string, next: TIntent, merge: (previous: TIntent | null, next: TIntent) => TIntent | null) => (
      await transact(recoveryKey, (current) => {
        const intent = merge(current.intent, next);
        return { intent, effectClaimToken: current.effectClaimToken, result: intent };
      })
    ),
    remove: async (recoveryKey: string) => {
      await transact(recoveryKey, () => ({ intent: null, effectClaimToken: null, result: undefined }));
    },
  };
}
