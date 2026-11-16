// Per-session softmax connected-service account selection: weight-model and burst acceptance through
// the deployed decision route (spec happier-selection-b6573fb3 revision 5, Appendix C.2 T3, T4, T22,
// T23; C.3 stage 2 "T3, T22 and T23 also through fixture pools of 15 members").
//
// Entry points exercised: server-light group, reservation and session routes; TWO daemons on the
// same account sharing the server reservation resource; each daemon's `/spawn-session` (initial
// draws and named starts) and `/connected-service-runtime-auth/failure` (failover draws); each
// daemon's quota loop, which fetches every member's usage from a fixture Claude OAuth usage endpoint
// (the provider boundary; it is the only place scores are injected). Draws use the daemon's own
// CSPRNG; nothing is injected into the decision. Evidence is read from what the daemon persists per
// decision: its durable ledger (`per-session-assignments.json`: target, reason, τ, δ, probability of
// the selected member, custody, proposal revision, settling reservation revision) and the server
// reservation rows.
//
// What the deployed route records per decision is the SELECTED member's probability only (not the
// full vector, the scores or the counts). Each draw therefore checks one component of the
// scenario's vector against results.json; full vectors are checked in-process by the landed unit
// tests (perSessionOffsetOddsSelection.test.ts). The trace-content clause of T22 is asserted
// separately and is expected to fail on builds that do not record the trace.
//
// Build under test: HAPPIER_E2E_PER_SESSION_CLI_SNAPSHOT_DIR, as in the first per-session suite.
// Trial counts: HAPPIER_E2E_PER_SESSION_MATH_{DRAWS_PER_SCENARIO,FAILOVER_TRIALS,BURST_TRIALS}.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  CLAUDE_CODE_E2E_OAUTH_SCOPE,
  CLAUDE_SUBSCRIPTION_SERVICE_ID,
  createConnectedServiceProfile,
  reportConnectedServiceRuntimeAuthFailure,
  requestConnectedClaudeSessionSpawn,
  startConnectedServiceRecoveryTokenServer,
  startConnectedServicesClaudeDaemon,
  type ConnectedServiceRecoveryTokenServer,
  type StartedConnectedServicesClaudeDaemonFixture,
} from '../../src/testkit/connectedServicesRecovery';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import {
  createPerSessionGroup,
  loadMathReference,
  meanAndSampleSd,
  perSessionMathQuotaEnv,
  randomSuffix,
  readDecisionLedger,
  readClaudeSessionBinding,
  readGroupReservations,
  readPerSessionGroup,
  referenceOffsetOddsProbabilities,
  startAdditionalConnectedServicesClaudeDaemon,
  startClaudeUsageFixtureServer,
  stopDaemonSession,
  type ClaudeUsageFixtureServer,
  type MathLedgerEntry,
  type MathReference,
  type MathScenario,
} from '../../src/testkit/perSessionSoftmaxMath';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });
const cliSnapshotDir = process.env.HAPPIER_E2E_PER_SESSION_CLI_SNAPSHOT_DIR?.trim() || undefined;
const intEnv = (name: string, fallback: number) => {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
/** Independent k=0 draws per results.json scenario (each in its own fresh group). */
const DRAWS_PER_SCENARIO = intEnv('HAPPIER_E2E_PER_SESSION_MATH_DRAWS_PER_SCENARIO', 2);
/** Eight-session failover bursts on the S6 pool (T4 structure; they also count toward the S6 mean). */
const FAILOVER_TRIALS = intEnv('HAPPIER_E2E_PER_SESSION_MATH_FAILOVER_TRIALS', 2);
/** Eight-session concurrent spawn bursts per pool (S6 and F1). */
const BURST_TRIALS = intEnv('HAPPIER_E2E_PER_SESSION_MATH_BURST_TRIALS', 12);
const BURST_SIZE = 8;

const SOFTMAX_FEATURE_ENV = { HAPPIER_FEATURE_CONNECTED_SERVICES_POOL_PER_SESSION_SOFTMAX__ENABLED: '1' };
const PROBABILITY_TOLERANCE = 1e-9;
const EXACT_TOLERANCE = 1e-12;
const FAILING_MEMBER = 'zfail';
const FAILING_MEMBER_SCORE = 50;

const log = (message: string, detail?: unknown) => {
  // Suite diagnostics; the run log is the record of every draw.
  console.log(`[math] ${message}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
};

type Daemon = Readonly<{ label: 'A' | 'B'; fixture: StartedConnectedServicesClaudeDaemonFixture }>;

/**
 * Profiles keyed by score: each distinct score value gets as many profiles as the most demanding
 * scenario needs, so one profile set serves every scenario and fixture.
 */
class ScoredProfiles {
  private readonly byScore = new Map<number, string[]>();
  readonly all: Array<{ profileId: string; score: number }> = [];

  require(scores: ReadonlyArray<number>): void {
    const counts = new Map<number, number>();
    for (const score of scores) counts.set(score, (counts.get(score) ?? 0) + 1);
    for (const [score, count] of counts) {
      const list = this.byScore.get(score) ?? [];
      while (list.length < count) {
        const profileId = `m${String(score).replace(/[^0-9]/gu, '_')}-${list.length}`;
        list.push(profileId);
        this.all.push({ profileId, score });
      }
      this.byScore.set(score, list);
    }
  }

  /** Member profile ids for a score array, in index order. */
  membersFor(scores: ReadonlyArray<number>): string[] {
    const used = new Map<number, number>();
    return scores.map((score) => {
      const ordinal = used.get(score) ?? 0;
      used.set(score, ordinal + 1);
      const profileId = this.byScore.get(score)?.[ordinal];
      if (!profileId) throw new Error(`no profile for score ${score} #${ordinal}`);
      return profileId;
    });
  }
}

const accessTokenOf = (profileId: string) => `access-${profileId}`;

describe('core e2e: per-session softmax weight model and bursts through the daemon decision route', () => {
  let reference: MathReference;
  let tokenServer: ConnectedServiceRecoveryTokenServer | null = null;
  let usageServer: ClaudeUsageFixtureServer | null = null;
  let daemonA: StartedConnectedServicesClaudeDaemonFixture | null = null;
  let daemonB: StartedConnectedServicesClaudeDaemonFixture | null = null;
  const profiles = new ScoredProfiles();
  const scenarioById = new Map<string, MathScenario>();
  /** A15 counts of the eight-decision S6 bursts (failover and spawn). */
  const s6A15Counts: Array<{ kind: 'failover' | 'spawn'; count: number }> = [];
  const daemons = (): [Daemon, Daemon] => {
    if (!daemonA || !daemonB) throw new Error('daemons not started');
    return [{ label: 'A', fixture: daemonA }, { label: 'B', fixture: daemonB }];
  };
  const fakeClaudeEnv = { HAPPIER_E2E_FAKE_CLAUDE_ALLOW_ACCESS_ONLY_NATIVE_OAUTH: '1' };
  const spawnedSessions: Array<{ daemon: Daemon; sessionId: string }> = [];

  beforeAll(async () => {
    reference = loadMathReference();
    log('reference', { source: reference.source, scenarios: reference.scenarios.map((s) => s.id) });
    for (const scenario of reference.scenarios) {
      scenarioById.set(scenario.id, scenario);
      profiles.require(scenario.scores);
    }
    const f1 = scenarioById.get('F1')!;
    for (const fresh of [90, 99, 99.9, 100]) profiles.require([...f1.scores.slice(0, -1), fresh]);
    profiles.require([60, 60]);
    profiles.require([100, 50]);
    profiles.require([100, 60]);

    const testDir = run.testDir('connected-services-per-session-softmax-math');
    tokenServer = await startConnectedServiceRecoveryTokenServer({ respond: () => ({ status: 400, body: { error: 'invalid_grant' } }) });
    usageServer = await startClaudeUsageFixtureServer();
    for (const { profileId, score } of profiles.all) usageServer.setRemainingPercent(accessTokenOf(profileId), score);
    usageServer.setRemainingPercent(accessTokenOf(FAILING_MEMBER), FAILING_MEMBER_SCORE);
    // Each daemon fetches through its own labelled usage URL, so readiness is checked per daemon.
    const daemonEnvFor = (label: string) => ({ ...SOFTMAX_FEATURE_ENV, ...fakeClaudeEnv, ...perSessionMathQuotaEnv(usageServer!.usageUrlFor(label)) });

    daemonA = await startConnectedServicesClaudeDaemon({
      testDir,
      testName: 'connected-services-per-session-softmax-math',
      tokenUrl: tokenServer.tokenUrl,
      fakeClaudePath: fakeClaudeFixturePath(),
      fakeClaudeLogPath: resolve(testDir, 'fake-claude-A.jsonl'),
      accountSettings: { claudeUnifiedTerminalEnabled: false },
      serverExtraEnv: { ...SOFTMAX_FEATURE_ENV, HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: '1' },
      extraEnv: daemonEnvFor('A'),
      ...(cliSnapshotDir ? { cliSnapshotDir } : {}),
    });
    daemonB = await startAdditionalConnectedServicesClaudeDaemon({
      primary: daemonA, testDir, label: 'B', tokenUrl: tokenServer.tokenUrl, fakeClaudePath: fakeClaudeFixturePath(),
      extraEnv: daemonEnvFor('B'), ...(cliSnapshotDir ? { cliSnapshotDir } : {}),
    });
    expect(daemonB.machineId).not.toBe(daemonA.machineId);

    const allProfileIds = [...profiles.all.map((entry) => entry.profileId), FAILING_MEMBER];
    for (const profileId of allProfileIds) {
      await createConnectedServiceProfile({
        fixture: daemonA, serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID, profileId,
        providerEmail: `${profileId}@example.test`, idToken: null,
        accessToken: accessTokenOf(profileId), refreshToken: `refresh-${profileId}`,
        scope: CLAUDE_CODE_E2E_OAUTH_SCOPE, tokenType: 'Bearer',
        providerAccountId: `acct-${profileId}`, expiresAt: Date.now() + 6 * 3600_000,
        oauthRaw: { claudeAiOauth: { organizationUuid: `org-${profileId}`, subscriptionType: 'max' } },
      });
    }
    log('profiles', { count: allProfileIds.length });
    // Each member's score reaches the daemons only through the quota loop's provider fetch. Daemons
    // of one account share that fetch under a per-member lease: one of them fetches, the other reads
    // the stored snapshot. Which daemon holds which member's score is therefore checked per daemon
    // and scenario through its decision route (awaitDaemonScores) before any measured draw.
    await waitFor(() => allProfileIds.every((profileId) => usageServer!.servedAccessTokens().has(accessTokenOf(profileId))), {
      timeoutMs: 600_000, intervalMs: 1_000,
      context: `quota loop fetched every member's usage (${usageServer.servedAccessTokens().size}/${allProfileIds.length})`,
    });
    // One more discovery/tick period so both daemons hold every snapshot.
    await new Promise((resolveWait) => setTimeout(resolveWait, 8_000));
    log('usage fetched', { requests: usageServer.requestCount() });
  }, 900_000);

  afterAll(async () => {
    for (const { daemon, sessionId } of spawnedSessions) await stopDaemonSession(daemon.fixture, sessionId);
    await daemonB?.daemon.stop().catch(() => {});
    await daemonA?.daemon.stop().catch(() => {});
    await daemonA?.server.stop().catch(() => {});
    await tokenServer?.stop().catch(() => {});
    await usageServer?.stop().catch(() => {});
  }, 180_000);

  /** One `/spawn-session` on `daemon`; returns the decision its ledger recorded for the session. */
  async function spawnDecision(daemon: Daemon, groupId: string, initialProfileId?: string): Promise<{ sessionId: string; entry: MathLedgerEntry }> {
    const requestedSessionId = randomUUID();
    const response = await requestConnectedClaudeSessionSpawn({
      fixture: daemon.fixture, sessionId: requestedSessionId, groupId,
      ...(initialProfileId ? { initialProfileId } : {}),
      extraEnvironmentVariables: fakeClaudeEnv,
    });
    if (response.status !== 200 || response.data.success !== true) {
      throw new Error(`spawn on ${daemon.label} in ${groupId} failed: ${response.status} ${JSON.stringify(response.data)}`);
    }
    const sessionId = String(response.data.sessionId);
    spawnedSessions.push({ daemon, sessionId });
    // The session's binding names its decision (materializedAssignment.decisionId); the daemon's
    // ledger holds the decision itself, under the daemon's own session subject id.
    let decisionId: string | null = null;
    await waitFor(async () => {
      const binding = await readClaudeSessionBinding(daemon.fixture, sessionId);
      const materialized = binding && typeof binding.materializedAssignment === 'object' ? binding.materializedAssignment as Record<string, unknown> : null;
      decisionId = typeof materialized?.decisionId === 'string' ? materialized.decisionId : null;
      return decisionId !== null;
    }, { timeoutMs: 30_000, intervalMs: 100, context: `materialized assignment for ${sessionId}` });
    const entries = (await readDecisionLedger(daemon.fixture, daemon.label))
      .filter((entry) => entry.decisionId === decisionId && entry.groupId === groupId && entry.origin === 'spawn');
    expect(entries, `ledger decision ${decisionId} for ${sessionId}`).toHaveLength(1);
    return { sessionId, entry: entries[0]! };
  }

  /**
   * Readiness of `daemon` for a member set: a probe draw in a throwaway group of exactly those members
   * records the reference k=0 probability for the member it selected. The selected probability is
   * normalized over the whole in-tier set, so it matches only when the daemon holds every in-tier
   * member's score, which is exactly what a measured draw on the same members depends on. Probe
   * groups are separate, so their reservations never count in a measured group.
   */
  async function awaitDaemonScores(daemon: Daemon, scores: ReadonlyArray<number>, label: string): Promise<void> {
    const members = profiles.membersFor(scores);
    const vector = referenceOffsetOddsProbabilities({ scores });
    let last: unknown = null;
    await waitFor(async () => {
      const groupId = `ready-${daemon.label.toLowerCase()}-${randomSuffix()}`;
      await createPerSessionGroup(daemon.fixture, { groupId, memberProfileIds: members, activeProfileId: members[0]! });
      let spawned: { sessionId: string; entry: MathLedgerEntry } | null = null;
      try {
        spawned = await spawnDecision(daemon, groupId);
      } catch (error) {
        last = String(error);
        return false;
      }
      await stopDaemonSession(daemon.fixture, spawned.sessionId);
      const expected = vector[members.indexOf(spawned.entry.proposal.profileId)];
      last = { selected: spawned.entry.proposal.profileId, probability: spawned.entry.proposal.probability, expected };
      return expected !== undefined && spawned.entry.proposal.probability !== null
        && Math.abs(spawned.entry.proposal.probability - expected) <= PROBABILITY_TOLERANCE;
    }, { timeoutMs: 900_000, intervalMs: 3_000, context: `daemon ${daemon.label} holds every in-tier score for ${label}` });
    log('daemon ready', { daemon: daemon.label, scenario: label, last });
  }

  async function stopAll(sessions: ReadonlyArray<{ daemon: Daemon; sessionId: string }>): Promise<void> {
    await Promise.all(sessions.map(({ daemon, sessionId }) => stopDaemonSession(daemon.fixture, sessionId)));
  }

  /**
   * Shared counts visible to every committed decision: orders a group's reserved decisions by the
   * reservation revision that committed them and checks each sampled decision's recorded probability
   * against the reference computed with exactly the earlier committed reservations as counts.
   */
  function verifyCommittedCounts(params: Readonly<{
    groupId: string;
    members: ReadonlyArray<string>;
    scores: ReadonlyArray<number>;
    decisions: ReadonlyArray<MathLedgerEntry>;
    excludedProfileId?: string;
    temperature?: number;
    offsetPercent?: number;
  }>): Array<{ decisionId: string; profileId: string; probability: number; expected: number; counts: number[]; proposalRevision: number; daemon: string }> {
    const committed = params.decisions.map((entry) => {
      expect(entry.proposal.custody, `${entry.decisionId} custody`).toBe('reserved');
      expect(typeof entry.proposal.observedReservationRevision).toBe('number');
      return entry;
    }).sort((left, right) => left.proposal.observedReservationRevision! - right.proposal.observedReservationRevision!);
    const revisions = committed.map((entry) => entry.proposal.observedReservationRevision);
    expect(new Set(revisions).size, `distinct committing revisions in ${params.groupId}`).toBe(revisions.length);
    const rows: Array<{ decisionId: string; profileId: string; probability: number; expected: number; counts: number[]; proposalRevision: number; daemon: string }> = [];
    committed.forEach((entry, position) => {
      if (entry.proposal.probability === null) return;
      const candidateIndexes = params.members.map((_, index) => index).filter((index) => params.members[index] !== params.excludedProfileId);
      const counts = candidateIndexes.map((index) => committed.slice(0, position).filter((earlier) => earlier.proposal.profileId === params.members[index]).length);
      const vector = referenceOffsetOddsProbabilities({
        scores: candidateIndexes.map((index) => params.scores[index]!), counts,
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        ...(params.offsetPercent !== undefined ? { offsetPercent: params.offsetPercent } : {}),
      });
      const selected = candidateIndexes.indexOf(params.members.indexOf(entry.proposal.profileId));
      expect(selected, `${entry.proposal.profileId} is a candidate`).toBeGreaterThanOrEqual(0);
      const expected = vector[selected]!;
      expect(expected, `${entry.decisionId} selected a zero-probability member`).toBeGreaterThan(0);
      expect(Math.abs(entry.proposal.probability - expected), `${entry.decisionId} probability vs counts ${JSON.stringify(counts)}`)
        .toBeLessThanOrEqual(PROBABILITY_TOLERANCE);
      rows.push({
        decisionId: entry.decisionId, profileId: entry.proposal.profileId, probability: entry.proposal.probability,
        expected, counts, proposalRevision: entry.proposal.proposalRevision, daemon: entry.daemonLabel,
      });
    });
    return rows;
  }

  it('T3 + T23 (E1–E4, P4) + T22: each daemon draw at k=0 matches the results.json vector for its scenario', async () => {
    // The reference implementation used for counted decisions reproduces results.json first.
    for (const scenario of reference.scenarios) {
      const vector = referenceOffsetOddsProbabilities({ scores: scenario.scores });
      vector.forEach((probability, index) => {
        expect(Math.abs(probability - scenario.probabilities[index]!), `${scenario.id}[${index}] reference`).toBeLessThanOrEqual(PROBABILITY_TOLERANCE);
      });
    }
    const [a, b] = daemons();
    const observed: Array<Record<string, unknown>> = [];
    let drawIndex = 0;
    for (const scenario of reference.scenarios) {
      const members = profiles.membersFor(scenario.scores);
      for (const daemon of [a, b]) await awaitDaemonScores(daemon, scenario.scores, scenario.id);
      for (let draw = 0; draw < DRAWS_PER_SCENARIO; draw += 1) {
        const daemon = drawIndex % 2 === 0 ? a : b;
        drawIndex += 1;
        const groupId = `t3-${scenario.id.toLowerCase()}-${draw}-${randomSuffix()}`;
        const group = await createPerSessionGroup(daemon.fixture, { groupId, memberProfileIds: members, activeProfileId: members[0]! });
        const { sessionId, entry } = await spawnDecision(daemon, groupId);
        const index = members.indexOf(entry.proposal.profileId);
        const expected = scenario.probabilities[index];
        observed.push({
          scenario: scenario.id, daemon: daemon.label, index, score: scenario.scores[index],
          probability: entry.proposal.probability, expected, diff: entry.proposal.probability === null || expected === undefined ? null : Math.abs(entry.proposal.probability - expected),
        });
        expect(entry.proposal).toMatchObject({ reason: 'initial_sampled', custody: 'reserved', temperature: 1.5, offsetPercent: 10 });
        expect(index, `${scenario.id}: selected ${entry.proposal.profileId} is a member`).toBeGreaterThanOrEqual(0);
        expect(expected!, `${scenario.id}: selected member has positive probability`).toBeGreaterThan(0);
        expect(Math.abs(entry.proposal.probability! - expected!), `${scenario.id}[${index}] daemon ${daemon.label}`).toBeLessThanOrEqual(PROBABILITY_TOLERANCE);
        if (scenario.id === 'E1') {
          // E1: the fresh account is the only member above the soft threshold: one preferred
          // destination, probability exactly one, no cap or redistribution (T23).
          expect(index).toBe(scenario.fresh[0]);
          expect(Math.abs(entry.proposal.probability! - 1)).toBeLessThanOrEqual(EXACT_TOLERANCE);
        }
        if (scenario.id === 'S1') {
          // Equal adjusted scores give a uniform vector (T22).
          expect(Math.abs(entry.proposal.probability! - 1 / 15)).toBeLessThanOrEqual(EXACT_TOLERANCE);
        }
        // The decision is a shared reservation on the server, and the shared pointer did not move.
        const rows = (await readGroupReservations(daemon.fixture, groupId)).reservations;
        expect(rows.find((row) => row.decisionId === entry.decisionId)).toMatchObject({
          profileId: entry.proposal.profileId, sessionId: entry.sessionId, ownerMachineId: daemon.fixture.machineId,
        });
        const after = await readPerSessionGroup(daemon.fixture, groupId);
        expect(after.activeProfileId).toBe(group.activeProfileId);
        expect(after.generation).toBe(group.generation);
        await stopDaemonSession(daemon.fixture, sessionId);
      }
    }
    log('k=0 draws', observed);
    // No probability cap (T23): fresh-account draws record their uncapped probability, e.g. F1's
    // 0.2401689761728719 and F15's 1/15 per account, and E1's sole preferred member records 1.
  }, 1_800_000);

  it('T22: the weight model at the daemon decision entry point (counts, singleton, δ, low τ, F1 boundary)', async () => {
    const [a, b] = daemons();
    const results: Record<string, unknown> = {};
    const f1Scenario = reference.scenarios.find((scenario) => scenario.id === 'F1')!;
    for (const [label, scores] of [
      ['pair60', [60, 60]], ['single', [60]], ['reserved100', [100, 50]], ['lowtau', [100, 60]],
      ...[90, 99, 99.9, 100].map((fresh) => [`f1-${fresh}`, [...f1Scenario.scores.slice(0, -1), fresh]] as const),
    ] as const) {
      for (const daemon of [a, b]) await awaitDaemonScores(daemon, scores, label);
    }

    // [60, 60] with counts [0, 1] (one named start on the second member; a named start is not a draw).
    {
      const members = profiles.membersFor([60, 60]);
      const groupId = `t22-pair60-${randomSuffix()}`;
      await createPerSessionGroup(a.fixture, { groupId, memberProfileIds: members, activeProfileId: members[0]! });
      const named = await spawnDecision(a, groupId, members[1]);
      expect(named.entry.proposal).toMatchObject({ reason: 'initial_requested', probability: null, profileId: members[1] });
      const drawn = await spawnDecision(b, groupId);
      const expected = drawn.entry.proposal.profileId === members[0] ? 0.6846951757131877 : 0.3153048242868123;
      expect(Math.abs(drawn.entry.proposal.probability! - expected)).toBeLessThanOrEqual(EXACT_TOLERANCE);
      results.pair60 = { selected: drawn.entry.proposal.profileId === members[0] ? 0 : 1, probability: drawn.entry.proposal.probability };
      await stopAll([{ daemon: a, sessionId: named.sessionId }, { daemon: b, sessionId: drawn.sessionId }]);
    }

    // Singleton tier: probability 1.
    {
      const members = profiles.membersFor([60]);
      const groupId = `t22-single-${randomSuffix()}`;
      await createPerSessionGroup(b.fixture, { groupId, memberProfileIds: members, activeProfileId: members[0]! });
      const drawn = await spawnDecision(b, groupId);
      expect(drawn.entry.proposal.profileId).toBe(members[0]);
      expect(Math.abs(drawn.entry.proposal.probability! - 1)).toBeLessThanOrEqual(EXACT_TOLERANCE);
      results.singleton = drawn.entry.proposal.probability;
      await stopAll([{ daemon: b, sessionId: drawn.sessionId }]);
    }

    // Observed [100, 50] with counts [1, 0]: one reservation lowers the 100% member's weight to
    // (50/(50+δ))^(1/τ), equal to the 50% member's, so the vector is [0.5, 0.5] at every δ,
    // including the smallest accepted δ (0.1) toward δ → 0.
    for (const offsetPercent of [10, 0.1]) {
      const members = profiles.membersFor([100, 50]);
      const groupId = `t22-reserved100-${String(offsetPercent).replace('.', '_')}-${randomSuffix()}`;
      await createPerSessionGroup(a.fixture, {
        groupId, memberProfileIds: members, activeProfileId: members[0]!, policy: { softmaxOffsetPercent: offsetPercent },
      });
      const named = await spawnDecision(a, groupId, members[0]);
      const drawn = await spawnDecision(b, groupId);
      expect(drawn.entry.proposal).toMatchObject({ offsetPercent, temperature: 1.5, reason: 'initial_sampled' });
      expect(Math.abs(drawn.entry.proposal.probability! - 0.5)).toBeLessThanOrEqual(EXACT_TOLERANCE);
      results[`reserved100_delta${offsetPercent}`] = drawn.entry.proposal.probability;
      await stopAll([{ daemon: a, sessionId: named.sessionId }, { daemon: b, sessionId: drawn.sessionId }]);
    }

    // Low τ: observed [100, 60] with two reservations on the 100% member gives adjusted [33.3, 60];
    // the higher ADJUSTED score dominates. The recorded probability matches the counted reference.
    {
      const members = profiles.membersFor([100, 60]);
      const groupId = `t22-lowtau-${randomSuffix()}`;
      await createPerSessionGroup(a.fixture, {
        groupId, memberProfileIds: members, activeProfileId: members[0]!, policy: { softmaxTemperature: 0.25 },
      });
      const named = [await spawnDecision(a, groupId, members[0]), await spawnDecision(b, groupId, members[0])];
      const drawn = await spawnDecision(a, groupId);
      const vector = referenceOffsetOddsProbabilities({ scores: [100, 60], counts: [2, 0], temperature: 0.25 });
      expect(vector[1]!).toBeGreaterThan(vector[0]!);
      expect(vector[1]!).toBeGreaterThan(0.95);
      const index = members.indexOf(drawn.entry.proposal.profileId);
      expect(drawn.entry.proposal.temperature).toBe(0.25);
      expect(Math.abs(drawn.entry.proposal.probability! - vector[index]!)).toBeLessThanOrEqual(PROBABILITY_TOLERANCE);
      results.lowTau = { selected: index, probability: drawn.entry.proposal.probability, vector };
      await stopAll([...named.map((entry, i) => ({ daemon: i === 0 ? a : b, sessionId: entry.sessionId })), { daemon: a, sessionId: drawn.sessionId }]);
    }

    // F1 boundary: 14 F1 members plus one at 90, 99, 99.9 and 100% free, zero counts. The selected
    // member's recorded probability matches the reference; the fresh member's probability is
    // checked against results.json boundary.by_delta["0.1"].F1_fresh_probability, directly when it
    // is selected and otherwise derived from the recorded probability and the closed-form weight
    // ratio (p_fresh = p_selected · w_fresh / w_selected).
    const f1 = reference.scenarios.find((scenario) => scenario.id === 'F1')!;
    const boundary: Array<Record<string, unknown>> = [];
    for (const [fraction, expectedFresh] of Object.entries(reference.f1BoundaryFreshProbability)) {
      if (Number(fraction) < 0.9) continue;
      const scores = [...f1.scores.slice(0, -1), Number(fraction) * 100 === 100 ? 100 : Number((Number(fraction) * 100).toPrecision(12))];
      const members = profiles.membersFor(scores);
      const daemon = boundary.length % 2 === 0 ? b : a;
      const groupId = `t22-boundary-${fraction.replace('.', '_')}-${randomSuffix()}`;
      await createPerSessionGroup(daemon.fixture, { groupId, memberProfileIds: members, activeProfileId: members[0]! });
      const drawn = await spawnDecision(daemon, groupId);
      const vector = referenceOffsetOddsProbabilities({ scores });
      expect(Math.abs(vector[14]! - expectedFresh), `reference fresh at ${fraction}`).toBeLessThanOrEqual(PROBABILITY_TOLERANCE);
      const index = members.indexOf(drawn.entry.proposal.profileId);
      const recorded = drawn.entry.proposal.probability!;
      expect(Math.abs(recorded - vector[index]!), `boundary ${fraction}[${index}]`).toBeLessThanOrEqual(PROBABILITY_TOLERANCE);
      const weight = (score: number) => (score / (100 - score + 10)) ** (1 / 1.5);
      const freshFromRecord = index === 14 ? recorded : recorded * weight(scores[14]!) / weight(scores[index]!);
      expect(Math.abs(freshFromRecord - expectedFresh), `fresh probability at ${fraction}`).toBeLessThanOrEqual(PROBABILITY_TOLERANCE);
      boundary.push({ fraction, index, recorded, freshFromRecord, expectedFresh, direct: index === 14 });
      await stopAll([{ daemon, sessionId: drawn.sessionId }]);
    }
    // At 100% and zero counts the fresh weight is finite, (100/δ)^(1/τ) = 10^(2/3).
    expect(Number.isFinite((100 / (100 - 100 + 10)) ** (1 / 1.5))).toBe(true);
    results.boundary = boundary;
    log('T22 daemon fixtures', results);
  }, 900_000);

  it('T22: the decision trace records scores, counts, τ, δ and probabilities', async () => {
    const [a] = daemons();
    const scenario = scenarioById.get('P4')!;
    const members = profiles.membersFor(scenario.scores);
    const groupId = `t22-trace-${randomSuffix()}`;
    await createPerSessionGroup(a.fixture, { groupId, memberProfileIds: members, activeProfileId: members[0]! });
    const { sessionId, entry } = await spawnDecision(a, groupId);
    // Wherever the daemon records this decision: its ledger entry, or a daemon log line naming it.
    const texts = [JSON.stringify(entry)];
    const daemonLogPath = a.fixture.daemon.state.daemonLogPath;
    if (daemonLogPath) {
      const raw = await readFile(daemonLogPath, 'utf8').catch(() => '');
      texts.push(...raw.split('\n').filter((line) => line.includes(entry.decisionId)));
    }
    const recordsTrace = texts.some((text) => (
      members.every((profileId) => text.includes(profileId))
      && scenario.probabilities.every((probability) => text.includes(String(probability).slice(0, 10)))
      && scenario.scores.every((score) => text.includes(String(score)))
    ));
    log('trace candidates', { decisionId: entry.decisionId, texts: texts.map((text) => text.slice(0, 600)) });
    await stopDaemonSession(a.fixture, sessionId);
    expect(recordsTrace, 'a persisted or logged trace with every member, score, count and probability for the decision').toBe(true);
  }, 120_000);

  it('T4 + T23: eight sessions fail together through two daemons and shared reservations (S6 pool)', async () => {
    const [a, b] = daemons();
    const s6 = scenarioById.get('S6')!;
    const s6Members = profiles.membersFor(s6.scores);
    const a15 = s6Members[13]!;
    const members = [FAILING_MEMBER, ...s6Members];
    const scores = [FAILING_MEMBER_SCORE, ...s6.scores];
    const conflicts: string[] = [];
    // The failover draws exclude the failing member; each daemon must hold every S6 score.
    for (const daemon of [a, b]) await awaitDaemonScores(daemon, s6.scores, 'S6');
    for (let trial = 0; trial < FAILOVER_TRIALS; trial += 1) {
      const groupId = `t4-failover-${trial}-${randomSuffix()}`;
      const created = await createPerSessionGroup(a.fixture, { groupId, memberProfileIds: members, activeProfileId: FAILING_MEMBER });
      // Eight sessions start on the same member by name (four per daemon). A named start is not a
      // weighted draw (T23): reason initial_requested, no probability.
      const started: Array<{ daemon: Daemon; sessionId: string; entry: MathLedgerEntry }> = [];
      for (let index = 0; index < BURST_SIZE; index += 1) {
        const daemon = index % 2 === 0 ? a : b;
        const spawned = await spawnDecision(daemon, groupId, FAILING_MEMBER);
        expect(spawned.entry.proposal).toMatchObject({ profileId: FAILING_MEMBER, reason: 'initial_requested', probability: null, custody: 'reserved' });
        started.push({ daemon, ...spawned });
      }
      const before = await readPerSessionGroup(a.fixture, groupId);
      expect(before.activeProfileId).toBe(FAILING_MEMBER);

      // They fail together: every session reports the member's usage limit to its own daemon at once.
      const failures = await Promise.all(started.map(({ daemon, sessionId }) => reportConnectedServiceRuntimeAuthFailure({
        fixture: daemon.fixture, sessionId, switchesThisTurn: 0,
        classification: {
          kind: 'usage_limit', limitCategory: 'quota', serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID, profileId: FAILING_MEMBER, groupId,
          resetsAtMs: Date.now() + 3600_000, retryAfterMs: 3600_000, quotaScope: 'account', providerLimitId: 'five_hour',
          planType: 'max', rateLimits: null, source: 'structured_provider_error',
        },
      })));
      log(`T4 trial ${trial} failure responses`, failures.map((failure) => ({ status: failure.status, result: failure.data.result })));

      // Separate decisions: one recovery decision per session, owned by that session's daemon.
      let recovery: MathLedgerEntry[] = [];
      await waitFor(async () => {
        const ledgers = [...await readDecisionLedger(a.fixture, 'A'), ...await readDecisionLedger(b.fixture, 'B')];
        recovery = ledgers.filter((entry) => entry.groupId === groupId && entry.origin === 'recovery' && entry.proposal.custody === 'reserved');
        return started.every(({ entry: spawned }) => recovery.some((entry) => entry.sessionId === spawned.sessionId));
      }, { timeoutMs: 120_000, intervalMs: 500, context: `T4 trial ${trial}: a reserved recovery decision for each of the eight sessions` });
      expect(new Set(recovery.map((entry) => entry.decisionId)).size).toBe(recovery.length);
      for (const { daemon, sessionId, entry: spawned } of started) {
        const own = recovery.filter((entry) => entry.sessionId === spawned.sessionId);
        expect(own, `recovery decisions for ${sessionId}`).toHaveLength(1);
        expect(own[0]!.daemonLabel).toBe(daemon.label);
        expect(own[0]!.proposal).toMatchObject({ fromProfileId: FAILING_MEMBER, temperature: 1.5, offsetPercent: 10 });
        expect(own[0]!.proposal.profileId).not.toBe(FAILING_MEMBER);
      }

      // Shared counts: every committed decision's probability reflects exactly the reservations
      // committed before it, across both daemons; a definite revision conflict re-proposed with the
      // recomputed probability (proposalRevision > 1) before any effect.
      const allDecisions = [...started.map((entry) => entry.entry), ...recovery];
      log(`T4 trial ${trial} decisions`, allDecisions.map((entry) => ({
        daemon: entry.daemonLabel, decisionId: entry.decisionId, subject: entry.sessionId, origin: entry.origin,
        profileId: entry.proposal.profileId, observedReservationRevision: entry.proposal.observedReservationRevision,
        proposalRevision: entry.proposal.proposalRevision, probability: entry.proposal.probability, custody: entry.proposal.custody,
      })));
      const rows = verifyCommittedCounts({ groupId, members, scores, decisions: allDecisions, excludedProfileId: FAILING_MEMBER });
      expect(rows).toHaveLength(BURST_SIZE);
      for (const row of rows) if (row.proposalRevision > 1) conflicts.push(row.decisionId);
      const reservations = (await readGroupReservations(a.fixture, groupId)).reservations;
      for (const entry of recovery) {
        expect(reservations.find((row) => row.decisionId === entry.decisionId), `server reservation for ${entry.decisionId}`)
          .toMatchObject({ profileId: entry.proposal.profileId, sessionId: entry.sessionId });
      }

      // No shared-pointer write: activeProfileId and generation are unchanged by eight failovers.
      const after = await readPerSessionGroup(a.fixture, groupId);
      expect(after.activeProfileId).toBe(FAILING_MEMBER);
      expect(after.generation).toBe(created.generation);

      const count = recovery.filter((entry) => entry.proposal.profileId === a15).length;
      s6A15Counts.push({ kind: 'failover', count });
      log(`T4 trial ${trial}`, { a15Count: count, rows });
      await stopAll(started);
    }
    log('T4 conflicts recomputed', { count: conflicts.length, decisions: conflicts });
    expect(conflicts.length, 'at least one definite reservation conflict was recomputed').toBeGreaterThan(0);
  }, 1_800_000);

  async function runSpawnBurst(scenarioId: 'S6' | 'F1', trial: number): Promise<{ targetCount: number; rows: ReturnType<typeof verifyCommittedCounts> }> {
    const [a, b] = daemons();
    const scenario = scenarioById.get(scenarioId)!;
    const members = profiles.membersFor(scenario.scores);
    const target = scenarioId === 'S6' ? members[13]! : members[scenario.fresh[0]!]!;
    const groupId = `burst-${scenarioId.toLowerCase()}-${trial}-${randomSuffix()}`;
    const created = await createPerSessionGroup(a.fixture, { groupId, memberProfileIds: members, activeProfileId: members[0]! });
    // Eight draws at once, four on each daemon, all against the same reservation resource.
    const spawned = await Promise.all(Array.from({ length: BURST_SIZE }, (_, index) => {
      const daemon = index % 2 === 0 ? a : b;
      return spawnDecision(daemon, groupId).then((result) => ({ daemon, ...result }));
    }));
    log(`burst ${groupId} decisions`, spawned.map(({ daemon, sessionId, entry }) => ({
      daemon: daemon.label, sessionId, decisionId: entry.decisionId, subject: entry.sessionId, profileId: entry.proposal.profileId,
      observedReservationRevision: entry.proposal.observedReservationRevision, proposalRevision: entry.proposal.proposalRevision,
      probability: entry.proposal.probability,
    })));
    const rows = verifyCommittedCounts({ groupId, members, scores: scenario.scores, decisions: spawned.map((entry) => entry.entry) });
    expect(rows).toHaveLength(BURST_SIZE);
    const after = await readPerSessionGroup(a.fixture, groupId);
    expect(after.activeProfileId).toBe(members[0]);
    expect(after.generation).toBe(created.generation);
    await stopAll(spawned);
    return { targetCount: spawned.filter((entry) => entry.entry.proposal.profileId === target).length, rows };
  }

  it('T4 + T23: eight-decision no-release bursts — S6 mean on A15 near 1.495 and F1 mean on the fresh account near 1.199', async () => {
    for (const id of ['S6', 'F1'] as const) {
      for (const daemon of daemons()) await awaitDaemonScores(daemon, scenarioById.get(id)!.scores, id);
    }
    const f1Counts: number[] = [];
    let conflicts = 0;
    for (let trial = 0; trial < BURST_TRIALS; trial += 1) {
      const s6 = await runSpawnBurst('S6', trial);
      s6A15Counts.push({ kind: 'spawn', count: s6.targetCount });
      const f1 = await runSpawnBurst('F1', trial);
      f1Counts.push(f1.targetCount);
      conflicts += [...s6.rows, ...f1.rows].filter((row) => row.proposalRevision > 1).length;
      log(`burst trial ${trial}`, { s6A15: s6.targetCount, f1Fresh: f1.targetCount });
    }
    const s6Values = s6A15Counts.map((entry) => entry.count);
    const s6Stats = meanAndSampleSd(s6Values);
    const s6Se = reference.s6BurstA15Sd / Math.sqrt(s6Values.length);
    const f1Stats = meanAndSampleSd(f1Counts);
    const f1Se = reference.f1BurstFreshSd / Math.sqrt(f1Counts.length);
    log('burst means', {
      s6: { trials: s6Values.length, kinds: s6A15Counts.map((entry) => entry.kind), mean: s6Stats.mean, sampleSd: s6Stats.sd, expected: reference.s6BurstA15Mean, se: s6Se, z: (s6Stats.mean - reference.s6BurstA15Mean) / s6Se },
      f1: { trials: f1Counts.length, mean: f1Stats.mean, sampleSd: f1Stats.sd, expected: reference.f1BurstFreshMean, se: f1Se, z: (f1Stats.mean - reference.f1BurstFreshMean) / f1Se },
      conflictsRecomputed: conflicts,
    });
    expect(Math.abs(s6Stats.mean - reference.s6BurstA15Mean)).toBeLessThanOrEqual(4 * s6Se);
    expect(Math.abs(f1Stats.mean - reference.f1BurstFreshMean)).toBeLessThanOrEqual(4 * f1Se);
  }, 3_600_000);
});
