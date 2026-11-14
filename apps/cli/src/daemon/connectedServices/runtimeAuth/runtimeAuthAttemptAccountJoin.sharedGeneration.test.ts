import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runConnectAttemptAccountsCommand } from '@/cli/commands/connect/connectAttemptAccounts';
import {
  RuntimeAuthAttemptAccountJoinEventSchema,
  buildRuntimeAuthAttemptTransitionEvent,
  createRuntimeAuthAttemptAccountJoinJournal,
  foldRuntimeAuthAttemptAccountJoins,
  type ProviderAccountObservedEvent,
  type RuntimeAuthAttemptAccountJoinEvent,
} from './runtimeAuthAttemptAccountJoin';

// Pool runners of one auth group share a single auth surface: a generation applied for any
// session's attempt replaces the credentials every session of the group runs with. These
// cases mirror retained production journal shapes (synthetic identifiers).

const SERVICE = 'claude-subscription';
const GROUP = 'pool';

type Intent = Parameters<typeof buildRuntimeAuthAttemptTransitionEvent>[0]['intent'];

function transition(sessionId: string, attemptId: string, persistedAtMs: number, overrides: Partial<Intent> = {}): RuntimeAuthAttemptAccountJoinEvent {
  return buildRuntimeAuthAttemptTransitionEvent({
    attemptId,
    transition: 'working',
    persistedAtMs,
    intent: {
      sessionId, serviceId: SERVICE, groupId: GROUP, profileId: null, status: 'waiting', attemptCount: 0,
      pendingTargetProfileId: null, pendingTargetGeneration: null, terminalReason: null,
      classification: { kind: 'usage_limit', sourceKey: null, runtimeIssueFingerprint: `fp-${attemptId}` },
      ...overrides,
    },
  });
}

function applied(sessionId: string, attemptId: string, startMs: number, target: string, generation: number): RuntimeAuthAttemptAccountJoinEvent[] {
  return [
    transition(sessionId, attemptId, startMs),
    transition(sessionId, attemptId, startMs + 10, { status: 'resumed_awaiting_proof', pendingTargetProfileId: target, pendingTargetGeneration: generation }),
  ];
}

function observed(sessionId: string, observedAtMs: number, profileId: string): ProviderAccountObservedEvent {
  return {
    v: 1, kind: 'provider_account_observed', sessionId, serviceId: SERVICE, groupId: GROUP,
    nativeSessionId: `native-${sessionId}`, providerOrganizationId: `org-${profileId}`,
    resolution: { kind: 'unique_member', profileId }, adoption: 'adopted', observedAtMs,
  };
}

function contractedProof(attemptId: string, observedAtMs: number): RuntimeAuthAttemptAccountJoinEvent {
  return {
    v: 1, kind: 'provider_outcome_proof', sessionId: 'matrix', attemptId, expectedAttemptId: attemptId,
    proofKind: 'provider_activity', observedAtMs, turnOwnership: 'exact_turn', completionContract: 'claude_sdk_result_bound_v1',
    statusBefore: 'resumed_awaiting_proof', statusAfter: 'recovered', attemptIdAfter: attemptId, persistedAtMs: observedAtMs + 1,
  };
}

describe('attempt-account join across a shared group generation', () => {
  it('does not count an observation made after another session applied a newer group generation', () => {
    const joins = foldRuntimeAuthAttemptAccountJoins([
      ...applied('matrix', 'a73', 1_000, 'sothmod-like', 73),
      ...applied('search', 'a80', 2_000, 'holdmod-like', 80),
      observed('matrix', 3_000, 'holdmod-like'),
    ]);
    const matrix = joins.find((join) => join.attemptId === 'a73')!;
    expect(matrix.observations.map((entry) => entry.disposition)).toEqual(['superseded_by_shared_generation']);
    expect(matrix.verdict).toBe('applied_awaiting_observation');
  });

  it('still counts an observation made before the next group generation began', () => {
    const joins = foldRuntimeAuthAttemptAccountJoins([
      ...applied('matrix', 'a73', 1_000, 'sothmod-like', 73),
      ...applied('search', 'a74', 2_000, 'holdmod-like', 74),
      observed('matrix', 1_500, 'sothmod-like'),
    ]);
    const matrix = joins.find((join) => join.attemptId === 'a73')!;
    expect(matrix.observations.map((entry) => entry.disposition)).toEqual(['counted']);
    // Counted credential metadata is reported as such; it never confirms the request principal.
    expect(matrix.verdict).toBe('principal_unknown');
    expect(matrix.applications[0]!.credentialMetadata).toBe('agrees');
  });

  it('does not count an observation while a missing group generation leaves the surface unknown', () => {
    // g74..g79 never reached this journal (for example pre-turn switches before the application
    // owner journaled them): between g73 and g80 the shared surface may have moved at any time.
    const joins = foldRuntimeAuthAttemptAccountJoins([
      ...applied('matrix', 'a73', 1_000, 'sothmod-like', 73),
      ...applied('search', 'a80', 2_000, 'holdmod-like', 80),
      observed('matrix', 1_500, 'sothmod-like'),
    ]);
    const matrix = joins.find((join) => join.attemptId === 'a73')!;
    expect(matrix.observations.map((entry) => entry.disposition)).toEqual(['generation_coverage_gap']);
    expect(matrix.verdict).toBe('boundary_uncertain');
  });

  it('closes an application at a journaled group generation from a pre-turn switch with no attempt', () => {
    const joins = foldRuntimeAuthAttemptAccountJoins([
      ...applied('matrix', 'a73', 1_000, 'sothmod-like', 73),
      {
        v: 1, kind: 'group_generation_applied', sessionId: 'other', serviceId: SERVICE, groupId: GROUP,
        generation: 74, profileId: 'mcortex-like', startedAtMs: 1_400, outcome: 'verified', persistedAtMs: 1_420,
      },
      observed('matrix', 1_300, 'sothmod-like'),
      observed('matrix', 1_500, 'mcortex-like'),
    ]);
    const matrix = joins.find((join) => join.attemptId === 'a73')!;
    expect(matrix.observations.map((entry) => entry.disposition)).toEqual(['counted', 'superseded_by_shared_generation']);
    expect(matrix.applications[0]!.credentialMetadata).toBe('agrees');
  });

  it('does not credit useful continuation to an application after the group surface moved on', () => {
    const joins = foldRuntimeAuthAttemptAccountJoins([
      ...applied('matrix', 'a73', 1_000, 'sothmod-like', 73),
      ...applied('search', 'a74', 2_000, 'holdmod-like', 74),
      {
        v: 1, kind: 'provider_outcome_proof', sessionId: 'matrix', attemptId: 'a73', expectedAttemptId: 'a73',
        proofKind: 'provider_activity', observedAtMs: 2_500, turnOwnership: 'exact_turn', completionContract: 'claude_sdk_result_bound_v1',
        statusBefore: 'resumed_awaiting_proof', statusAfter: 'recovered', attemptIdAfter: 'a73', persistedAtMs: 2_501,
      },
    ]);
    expect(joins.find((join) => join.attemptId === 'a73')!.usefulContinuation).toEqual({ kind: 'not_witnessed' });
  });

  it('does not credit useful continuation while a missing group generation leaves the serving generation unknown', async () => {
    // JOIN-GAP-1: g74..g79 are absent, so which generation served contracted activity at 1500 is
    // unknown. Keep the proof, but report boundary uncertainty, never useful continuation of g73.
    const events = [
      ...applied('matrix', 'a73', 1_000, 'sothmod-like', 73),
      ...applied('search', 'a80', 2_000, 'holdmod-like', 80),
      observed('matrix', 1_500, 'sothmod-like'),
      contractedProof('a73', 1_500),
    ];
    const matrix = foldRuntimeAuthAttemptAccountJoins(events).find((join) => join.attemptId === 'a73')!;
    expect(matrix.observations.map((entry) => entry.disposition)).toEqual(['generation_coverage_gap']);
    expect(matrix.usefulContinuation).toEqual({ kind: 'boundary_uncertain', observedAtMs: 1_500, applicationIndex: 0 });

    // The same journal through the real append-only writer, reader and session-filtered CLI.
    const dir = await mkdtemp(join(tmpdir(), 'happier-join-gap-'));
    try {
      const journal = createRuntimeAuthAttemptAccountJoinJournal({ filePath: join(dir, 'attempt-accounts.jsonl') });
      for (const event of events) await journal.append(event);
      let output = '';
      await runConnectAttemptAccountsCommand({ args: ['--session', 'matrix'], journal, write: (line) => { output += line; } });
      const view = JSON.parse(output);
      expect(view.invalidLines).toEqual([]);
      expect(view.attempts).toHaveLength(1);
      expect(view.attempts[0].observations[0].disposition).toBe('generation_coverage_gap');
      expect(view.attempts[0].usefulContinuation).toEqual({ kind: 'boundary_uncertain', observedAtMs: 1_500, applicationIndex: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('still credits contracted useful continuation before the next contiguous generation', () => {
    const joins = foldRuntimeAuthAttemptAccountJoins([
      ...applied('matrix', 'a73', 1_000, 'sothmod-like', 73),
      ...applied('search', 'a74', 2_000, 'holdmod-like', 74),
      contractedProof('a73', 1_500),
    ]);
    expect(joins.find((join) => join.attemptId === 'a73')!.usefulContinuation)
      .toEqual({ kind: 'provider_activity', observedAtMs: 1_500, applicationIndex: 0 });
  });

  it('reports legacy exact-turn activity without a completion contract as unqualified, never useful', () => {
    // Rows from runners before the completion contract: their raw bytes parse unchanged (no
    // retrofit), and the derived reader keeps the scheduler's recovery separate from usefulness.
    const legacyProof = RuntimeAuthAttemptAccountJoinEventSchema.parse(JSON.parse(JSON.stringify({
      v: 1, kind: 'provider_outcome_proof', sessionId: 'matrix', attemptId: 'a73', expectedAttemptId: 'a73',
      proofKind: 'provider_activity', observedAtMs: 1_100, turnOwnership: 'exact_turn',
      statusBefore: 'resumed_awaiting_proof', statusAfter: 'recovered', attemptIdAfter: 'a73', persistedAtMs: 1_101,
    })));
    expect(legacyProof).toMatchObject({ completionContract: null });
    const [join] = foldRuntimeAuthAttemptAccountJoins([
      ...applied('matrix', 'a73', 1_000, 'sothmod-like', 73),
      transition('matrix', 'a73', 1_102, { status: 'recovered', pendingTargetProfileId: 'sothmod-like', pendingTargetGeneration: 73 }),
      legacyProof,
    ]);
    expect(join!.usefulContinuation).toEqual({ kind: 'provider_activity_completion_unqualified', observedAtMs: 1_100, applicationIndex: 0 });
    expect(join!.schedulerRecovered).toEqual({ persistedAtMs: 1_102, proofKinds: ['provider_activity'] });
  });

  it('reads a mixed-version journal: legacy rows keep parsing and new rows only add boundaries', () => {
    const legacyLine = JSON.stringify({
      v: 1, kind: 'provider_account_observed', sessionId: 'matrix', serviceId: SERVICE, groupId: GROUP,
      nativeSessionId: 'native-matrix', providerOrganizationId: 'org-x', resolution: { kind: 'unique_member', profileId: 'x' },
      adoption: 'adopted', observedAtMs: 5,
    });
    expect(RuntimeAuthAttemptAccountJoinEventSchema.parse(JSON.parse(legacyLine))).toMatchObject({ kind: 'provider_account_observed' });
    expect(() => RuntimeAuthAttemptAccountJoinEventSchema.parse({
      v: 1, kind: 'group_generation_applied', sessionId: null, serviceId: SERVICE, groupId: GROUP,
      generation: 1, profileId: 'x', startedAtMs: 1, outcome: 'guessed', persistedAtMs: 2,
    })).toThrow();
  });
});
