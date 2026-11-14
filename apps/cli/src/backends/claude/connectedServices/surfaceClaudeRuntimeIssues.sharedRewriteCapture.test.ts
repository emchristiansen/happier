import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { ConnectedServiceAuthGroupGenerationConsumer } from '@/daemon/connectedServices/accountGroups/generation/ConnectedServiceAuthGroupGenerationConsumer';
import { createSharedGenerationApplication } from '@/daemon/connectedServices/accountGroups/generation/createSharedGenerationApplication';
import { resolveRuntimeGenerationApplicationProofs } from '@/daemon/connectedServices/accountGroups/generation/resolveRuntimeGenerationApplicationProofs';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { buildConnectedServiceAuthGroupCommittedGenerationFact } from '@/daemon/connectedServices/sessionAuthSwitch/connectedServiceAuthSwitchOutcome';

import { applyClaudeSharedGroupGenerationApplication } from './applyClaudeSharedGroupGenerationApplication';
import { ClaudeConnectedServiceAuthGroupRequestFence } from './claudeConnectedServiceAuthGroupRequestFence';
import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './nativeAuth/claudeCodeCredentialScopes';
import { resolveClaudeConnectedServiceStableConfigDir } from './resolveClaudeConnectedServiceStableAuthDir';
import {
  captureClaudeRuntimeAuthRequestIdentity,
  recordClaudeRateLimitQuotaEvidence,
  surfaceClaudeRateLimitRuntimeIssue,
} from './surfaceClaudeRuntimeIssues';
import { verifyClaudeSharedGroupGenerationApplication } from './verifyClaudeSharedGroupGenerationApplication';

// The only scheduling seam is the real `.claude.json` read; the generation consumer, shared
// application, materializer, credential/root/provenance writers, identity reader, capture and fence
// are all real. Daemon transport is the only substituted boundary.
const readGate = vi.hoisted(() => ({ before: null as null | (() => Promise<void>), path: '' }));
// Publication-failure seam: the real atomic writer's final rename onto one destination path.
const renameGate = vi.hoisted(() => ({ fail: null as null | NodeJS.ErrnoException, path: '', failures: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (readGate.before && String(args[0]) === readGate.path) {
        const before = readGate.before;
        readGate.before = null;
        await before();
      }
      return await actual.readFile(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (renameGate.fail && String(args[1]) === renameGate.path) {
        renameGate.failures += 1;
        throw renameGate.fail;
      }
      return await actual.rename(...args);
    },
  };
});
const notifyFailure = vi.hoisted(() => vi.fn(async (_input: any) => ({})));
const notifyQuota = vi.hoisted(() => vi.fn(async (_input: any) => ({ ok: true })));
vi.mock('@/daemon/controlClient', () => ({
  notifyDaemonConnectedServiceRuntimeAuthFailure: notifyFailure,
  notifyDaemonConnectedServiceQuotaSnapshot: notifyQuota,
  notifyDaemonConnectedServiceTurnLifecycle: vi.fn(async () => ({ ok: true })),
}));

const revA = 'csr_7123456789ABCDEFGHJKMNPQRS';
const revB = 'csr_8123456789ABCDEFGHJKMNPQRS';
const initialTruth = { kind: 'current_auth_group_available' as const, groupId: 'team-pool', generation: 4, credentialRevision: revA };

function credential(profileId: string, account: string) {
  return buildConnectedServiceCredentialRecord({
    now: 1000, serviceId: 'claude-subscription', profileId, kind: 'oauth', expiresAt: Date.now() + 60_000,
    oauth: {
      accessToken: `test-access-${account}`, refreshToken: `test-refresh-${account}`, idToken: null,
      scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE, tokenType: 'Bearer', providerAccountId: `acct-${account}`,
      providerEmail: `${account}@example.test`, raw: { claudeAiOauth: { organizationUuid: `org-${account}` } },
    },
  });
}

type Move = Readonly<{ profileId: string; generation: number; credentialRevision: string }>;

describe('request identity capture against the real shared group writer', () => {
  let root: string;
  let configDir: string;
  let previousSelections: string | undefined;
  let previousConfigDir: string | undefined;

  async function applyDirectly(move: Move): Promise<void> {
    const result = await applyClaudeSharedGroupGenerationApplication({
      activeServerDir: root, serviceId: 'claude-subscription', groupId: 'team-pool', profileId: move.profileId,
      generation: move.generation, credentialRevision: move.credentialRevision as never,
      record: credential(move.profileId, move.profileId === 'a' && move.credentialRevision === revA ? 'a' : 'b'),
      validateCurrentBeforeMutation: async () => ({ current: true }),
    });
    expect(result.status).toBe('verified');
  }

  /** The ordinary shared consumer: rewrite the shared home, then notify the runner (held). */
  function startSharedConsumer(move: Move, fence: ClaudeConnectedServiceAuthGroupRequestFence, sessionId: string) {
    let notificationStarted!: () => void;
    let releaseNotification!: () => void;
    const reached = new Promise<void>((resolve) => { notificationStarted = resolve; });
    const held = new Promise<void>((resolve) => { releaseNotification = resolve; });
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
      resolveGenerationApplicationScope: async () => ({ status: 'supported', scope: 'shared_group_auth_surface', ownerId: 'claude' }),
      verifySharedGenerationApplication: async () => null,
      applyCommittedGeneration: async () => { throw new Error('unexpected per-session writer'); },
      applySharedGenerationApplication: createSharedGenerationApplication({
        activeServerDir: root,
        resolveDescriptor: async () => ({ applySharedGenerationApplication: applyClaudeSharedGroupGenerationApplication }),
        resolveTargetCredential: async () => ({ credentialRevision: move.credentialRevision as never, record: credential(move.profileId, 'b') }),
        validateCurrentness: async () => ({ current: true }),
        readMemberHolds: async () => ({ status: 'readable', holdsByProfileId: new Map() } as never),
        nowMs: () => Date.now(),
        recordGroupGenerationApplied: () => {},
      }),
      notifyCurrentGroupTruth: async (input) => {
        notificationStarted();
        await held;
        fence.applyCurrentTruth(input.currentTruth);
        return { ok: true };
      },
    });
    const consumption = consumer.consume({
      executionAuthority: 'runtime_recovery',
      switchReason: 'automatic_runtime_failure',
      sessions: [{ sessionId, activity: 'live', applicationOwnerId: 'claude' }],
      committedGeneration: buildConnectedServiceAuthGroupCommittedGenerationFact({
        decisionId: 'shared-rewrite-capture',
        provenance: 'reconciliation',
        decisionCommittedTarget: { serviceId: 'claude-subscription', groupId: 'team-pool', ...move } as never,
      }),
    });
    return { reached, releaseNotification, consumption };
  }

  function runnerSession(name: string, fence: ClaudeConnectedServiceAuthGroupRequestFence) {
    return { connectedServiceAuthGroupRequestFence: fence,
      client: { sessionId: `shared-capture-${name}`, sessionTurnLifecycle: { failTurn: async () => {} } } };
  }

  async function reportedFailure(session: ReturnType<typeof runnerSession>) {
    notifyFailure.mockClear();
    await surfaceClaudeRateLimitRuntimeIssue(session, {
      v: 1, resetAtMs: null, retryAfterMs: null, limitCategory: 'usage_limit', quotaScope: 'account',
      recoverability: 'wait', planType: null, utilization: 100, overage: null, action: null, connectedService: null,
    }, '[shared-capture]');
    return notifyFailure.mock.calls.at(-1)?.[0]?.classification;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'shared-capture-'));
    await applyDirectly({ profileId: 'a', generation: 4, credentialRevision: revA });
    configDir = resolveClaudeConnectedServiceStableConfigDir({
      activeServerDir: root, serviceId: 'claude-subscription', fallbackProfileId: 'a',
      selection: { kind: 'group', serviceId: 'claude-subscription', groupId: 'team-pool', activeProfileId: 'a',
        fallbackProfileId: 'a', generation: 4, credentialRevision: revA, record: credential('a', 'a'), policy: null } as never,
    })!;
    previousSelections = process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = JSON.stringify([{ kind: 'group',
      serviceId: 'claude-subscription', groupId: 'team-pool', activeProfileId: 'a', fallbackProfileId: 'a',
      generation: 4, credentialRevision: revA }]);
    process.env.CLAUDE_CONFIG_DIR = configDir;
    readGate.path = join(configDir, '.claude.json');
  });

  afterEach(async () => {
    readGate.before = null;
    renameGate.fail = null;
    renameGate.failures = 0;
    if (previousSelections === undefined) delete process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    else process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = previousSelections;
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    { name: 'generation 4 to 5', move: { profileId: 'b', generation: 5, credentialRevision: revB } },
    { name: 'same-profile same-generation credential revision', move: { profileId: 'a', generation: 4, credentialRevision: revB } },
  ])('reports the account unproven after a $name rewrite whose runner notification is still pending', async ({ name, move }) => {
    const fence = new ClaudeConnectedServiceAuthGroupRequestFence();
    fence.applyCurrentTruth(initialTruth);
    const session = runnerSession(name, fence);
    const consumer = startSharedConsumer(move, fence, session.client.sessionId);
    // The shared home now holds account B; this runner has not yet been told.
    await consumer.reached;
    await captureClaudeRuntimeAuthRequestIdentity(session);
    expect(fence.readCurrentTruth()).toEqual(initialTruth);
    consumer.releaseNotification();
    await consumer.consumption;

    const reported = await reportedFailure(session);
    expect(reported).toMatchObject({ groupGeneration: 4, credentialRevision: revA,
      sourceProviderAccountId: null, sourceProviderOrganizationId: null });
  });

  it.each([
    { name: 'generation 4 to 5', move: { profileId: 'b', generation: 5, credentialRevision: revB } },
    { name: 'same-profile same-generation credential revision', move: { profileId: 'a', generation: 4, credentialRevision: revB } },
  ])('never pairs a later account with the recorded tuple when a $name rewrite races the read', async ({ name, move }) => {
    const fence = new ClaudeConnectedServiceAuthGroupRequestFence();
    fence.applyCurrentTruth(initialTruth);
    const session = runnerSession(`race-${name}`, fence);
    let consumer: ReturnType<typeof startSharedConsumer> | null = null;
    readGate.before = async () => {
      consumer = startSharedConsumer(move, fence, session.client.sessionId);
      // A writer that can run now completes its rewrite before the read continues; one excluded
      // by the reader's coherent snapshot cannot, and the read proceeds after this bound.
      await Promise.race([consumer.reached, new Promise((resolve) => setTimeout(resolve, 1_000))]);
    };
    await captureClaudeRuntimeAuthRequestIdentity(session);
    expect(consumer).not.toBeNull();
    consumer!.releaseNotification();
    await consumer!.consumption;

    const reported = await reportedFailure(session);
    expect(reported).toMatchObject({ groupGeneration: 4, credentialRevision: revA });
    // Either unproven, or the account actually materialized for generation 4 / revision A.
    expect([null, 'acct-a']).toContain(reported.sourceProviderAccountId);
  });

  it.each([
    { name: 'generation', move: { profileId: 'b', generation: 5, credentialRevision: revB } },
    { name: 'credential revision', move: { profileId: 'a', generation: 4, credentialRevision: revB } },
  ])('reports the account unproven when the $name notification is delivered during the read', async ({ name, move }) => {
    const fence = new ClaudeConnectedServiceAuthGroupRequestFence();
    fence.applyCurrentTruth(initialTruth);
    const session = runnerSession(`delivered-${name}`, fence);
    let write: Promise<void> | null = null;
    readGate.before = async () => {
      write = applyDirectly(move);
      fence.applyCurrentTruth({ ...initialTruth, generation: move.generation, credentialRevision: move.credentialRevision });
    };
    await captureClaudeRuntimeAuthRequestIdentity(session);
    await write;

    const reported = await reportedFailure(session);
    expect(reported).toMatchObject({ sourceProviderAccountId: null, sourceProviderOrganizationId: null });
  });

  it('keeps the coherent account when the shared home does not move', async () => {
    const fence = new ClaudeConnectedServiceAuthGroupRequestFence();
    fence.applyCurrentTruth(initialTruth);
    const session = runnerSession('stable', fence);
    await captureClaudeRuntimeAuthRequestIdentity(session);

    const reported = await reportedFailure(session);
    expect(reported).toMatchObject({ profileId: 'a', groupGeneration: 4, credentialRevision: revA,
      sourceProviderAccountId: 'acct-a', sourceProviderOrganizationId: 'org-a' });
  });

  it('keeps the coherent account for a launch selection that has no delivered truth', async () => {
    const session = { client: { sessionId: 'shared-capture-no-truth', sessionTurnLifecycle: { failTurn: async () => {} } } };
    await captureClaudeRuntimeAuthRequestIdentity(session);

    const reported = await reportedFailure(session as never);
    expect(reported).toMatchObject({ groupGeneration: 4, credentialRevision: revA, sourceProviderAccountId: 'acct-a' });
  });
  it.each([
    { name: 'generation 4 to 5', move: { profileId: 'b', generation: 5, credentialRevision: revB } },
    { name: 'same-profile same-generation credential revision', move: { profileId: 'a', generation: 4, credentialRevision: revB } },
  ])('reports the account unproven when a $name rewrite fails at its final provenance publication', async ({ name, move }) => {
    const fence = new ClaudeConnectedServiceAuthGroupRequestFence();
    fence.applyCurrentTruth(initialTruth);
    const session = runnerSession(`partial-${name}`, fence);
    renameGate.path = join(configDir, '.happier-claude-connected-service-home.json');
    renameGate.fail = Object.assign(new Error('injected EACCES at provenance publication'), { code: 'EACCES' });
    const { releaseNotification, consumption } = startSharedConsumer(move, fence, session.client.sessionId);
    releaseNotification();
    const outcome = await consumption as { ok?: boolean };
    renameGate.fail = null;

    // Credentials and root identity moved to B; the provenance publication failed; nothing was
    // acknowledged and the runner was never told of a new generation.
    expect(renameGate.failures).toBe(1);
    expect(outcome.ok).toBe(false);
    expect(fence.readCurrentTruth()).toEqual(initialTruth);
    const { readFile } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    expect(JSON.parse(await readFile(join(configDir, '.claude.json'), 'utf8')).oauthAccount.accountUuid).toBe('acct-b');
    await expect(readFile(renameGate.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await captureClaudeRuntimeAuthRequestIdentity(session);
    expect(await reportedFailure(session)).toMatchObject({
      groupGeneration: 4, credentialRevision: revA, sourceProviderAccountId: null, sourceProviderOrganizationId: null,
    });

    // A later successful publication of the same move restores a coherent, attributable home.
    await applyDirectly(move);
    fence.applyCurrentTruth({ ...initialTruth, generation: move.generation, credentialRevision: move.credentialRevision });
    process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = JSON.stringify([{ kind: 'group',
      serviceId: 'claude-subscription', groupId: 'team-pool', activeProfileId: move.profileId, fallbackProfileId: 'a',
      generation: move.generation, credentialRevision: move.credentialRevision }]);
    const recovered = runnerSession(`partial-recovered-${name}`, fence);
    await captureClaudeRuntimeAuthRequestIdentity(recovered);
    expect(await reportedFailure(recovered)).toMatchObject({ sourceProviderAccountId: 'acct-b', sourceProviderOrganizationId: 'org-b' });
  });
  async function deliveredQuota(session: ReturnType<typeof runnerSession>) {
    notifyQuota.mockClear();
    await recordClaudeRateLimitQuotaEvidence(session, [{
      v: 1, resetAtMs: null, retryAfterMs: null, limitCategory: 'usage_limit', quotaScope: 'account',
      recoverability: 'wait', planType: null, utilization: 95, overage: null, action: null, connectedService: null,
    }], '[shared-capture]');
    await vi.waitFor(() => expect(notifyQuota).toHaveBeenCalled());
    return notifyQuota.mock.calls.at(-1)![0];
  }

  function verifyProof(move: Move) {
    return verifyClaudeSharedGroupGenerationApplication({
      serviceId: 'claude-subscription', groupId: 'team-pool', profileId: move.profileId, generation: move.generation,
      credentialRevision: move.credentialRevision as never, environmentVariables: { CLAUDE_CONFIG_DIR: configDir },
    });
  }

  it('keeps passive quota evidence but never stamps the next account under the unchanged tuple after a failed publication', async () => {
    const fence = new ClaudeConnectedServiceAuthGroupRequestFence();
    fence.applyCurrentTruth(initialTruth);
    const session = runnerSession('passive-quota', fence);
    // Control: a coherent home attributes the passive window to the account it actually holds.
    expect(await deliveredQuota(session)).toMatchObject({ groupGeneration: 4, sourceProviderAccountId: 'acct-a' });

    renameGate.path = join(configDir, '.happier-claude-connected-service-home.json');
    renameGate.fail = Object.assign(new Error('injected EACCES at provenance publication'), { code: 'EACCES' });
    const { releaseNotification, consumption } = startSharedConsumer(
      { profileId: 'b', generation: 5, credentialRevision: revB }, fence, session.client.sessionId);
    releaseNotification();
    expect((await consumption as { ok?: boolean }).ok).toBe(false);
    renameGate.fail = null;

    const delivered = await deliveredQuota(session);
    // The provider's in-band window is kept in full; only the account join is withheld.
    expect(delivered).toMatchObject({ groupId: 'team-pool', groupGeneration: 4 });
    expect(delivered.sourceProviderAccountId ?? null).toBeNull();
    expect(delivered.snapshot).toMatchObject({ profileId: 'a', confidence: 'exact', source: 'in_band_provider_snapshot' });
    expect(delivered.snapshot.activeAccountId ?? null).toBeNull();
    expect(delivered.snapshot.meters).toEqual([expect.objectContaining({ utilizationPct: 95, remainingPct: 5 })]);
  });

  it('certifies a generation only from one publication while a rewrite to the next member fails', async () => {
    const a = { profileId: 'a', generation: 4, credentialRevision: revA };
    const b = { profileId: 'b', generation: 5, credentialRevision: revB };
    const { readFile } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const credentialsPath = join(configDir, '.credentials.json');
    const provenancePath = join(configDir, '.happier-claude-connected-service-home.json');
    const aCredentials = await readFile(credentialsPath, 'utf8');
    const aFingerprint = JSON.parse(await readFile(provenancePath, 'utf8')).credentialFingerprint;

    // The real verifier has read A's provenance record and pauses at its credentials read.
    let paused!: () => void;
    let resume!: () => void;
    const reachedCredentials = new Promise<void>((resolve) => { paused = resolve; });
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    readGate.path = credentialsPath;
    readGate.before = async () => { paused(); await resumed; };
    const verifying = verifyProof(a);
    await reachedCredentials;

    // The ordinary shared rewrite to B starts now and fails at its final provenance publication.
    const fence = new ClaudeConnectedServiceAuthGroupRequestFence();
    fence.applyCurrentTruth(initialTruth);
    renameGate.path = provenancePath;
    renameGate.fail = Object.assign(new Error('injected EACCES at provenance publication'), { code: 'EACCES' });
    const { releaseNotification, consumption } = startSharedConsumer(b, fence, 'shared-capture-verify');
    releaseNotification();
    // The writer cannot touch the home while the verifier's snapshot is open.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readFile(credentialsPath, 'utf8')).toBe(aCredentials);
    resume();
    expect(await verifying).toMatchObject({ status: 'verified', credentialRevision: revA, credentialFingerprint: aFingerprint });
    expect((await consumption as { ok?: boolean }).ok).toBe(false);
    renameGate.fail = null;

    // After the failed publication neither member is certified, and the home holds B's credentials.
    expect(await readFile(credentialsPath, 'utf8')).not.toBe(aCredentials);
    expect(await verifyProof(a)).toEqual({ status: 'unavailable' });
    expect(await verifyProof(b)).toEqual({ status: 'unavailable' });
    // A later successful publication of B is certified again.
    await applyDirectly(b);
    expect(await verifyProof(b)).toMatchObject({ status: 'verified', credentialRevision: revB });
    expect(await verifyProof(a)).toEqual({ status: 'unavailable' });
  });
  /** A consumer re-adopting A for a live session, through the real runtime proof resolver and verifier. */
  function startAdoptingConsumer(name: string) {
    const notified: unknown[] = [];
    let applyCalls = 0;
    const target = { sessionId: `adopt-${name}`, agentId: 'claude' as const,
      connectedServiceSelectionsEnv: { CLAUDE_CONFIG_DIR: configDir },
      activeBindings: [{ serviceId: 'claude-subscription' as const, groupId: 'team-pool', profileId: 'a', generation: 4,
        credentialRevision: revA as never }] };
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
      resolveGenerationApplicationScope: async () => ({ status: 'supported', scope: 'shared_group_auth_surface', ownerId: 'claude' }),
      verifySharedGenerationApplication: async () => (await resolveRuntimeGenerationApplicationProofs({
        target,
        resolveLifecycleDescriptor: async () => ({ verifyGenerationApplication: verifyClaudeSharedGroupGenerationApplication }),
        getCurrentGroup: async () => ({ serviceId: 'claude-subscription', groupId: 'team-pool', activeProfileId: 'a', generation: 4 }),
        isCurrent: () => true,
      } as never))[0] ?? null,
      applyCommittedGeneration: async () => { throw new Error('unexpected per-session writer'); },
      // Without a proof the consumer would rewrite; this stand-in refuses so a proof alone decides success.
      applySharedGenerationApplication: async () => { applyCalls += 1; return { reconciliationDisposition: 'failed', errorCode: 'no_apply' } as never; },
      notifyCurrentGroupTruth: async (input) => { notified.push(input); return { ok: true }; },
    });
    const consumption = consumer.consume({
      executionAuthority: 'runtime_recovery',
      switchReason: 'automatic_runtime_failure',
      sessions: [{ sessionId: target.sessionId, activity: 'live', applicationOwnerId: 'claude' }],
      committedGeneration: buildConnectedServiceAuthGroupCommittedGenerationFact({
        decisionId: `adopt-${name}`, provenance: 'reconciliation',
        decisionCommittedTarget: { serviceId: 'claude-subscription', groupId: 'team-pool', profileId: 'a', generation: 4, credentialRevision: revA } as never,
      }),
    });
    return { consumption: consumption as Promise<{ acknowledgeable?: boolean; ok?: boolean }>, notified, applyCalls: () => applyCalls };
  }

  it('acknowledges a reader-first coherent A, and never A again after a same-member revision B failed publication', async () => {
    const { readFile } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const credentialsPath = join(configDir, '.credentials.json');
    const aCredentials = await readFile(credentialsPath, 'utf8');
    let paused!: () => void;
    let resume!: () => void;
    const reachedCredentials = new Promise<void>((resolve) => { paused = resolve; });
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    readGate.path = credentialsPath;
    readGate.before = async () => { paused(); await resumed; };
    const readerFirst = startAdoptingConsumer('reader-first');
    await reachedCredentials;

    const fence = new ClaudeConnectedServiceAuthGroupRequestFence();
    fence.applyCurrentTruth(initialTruth);
    renameGate.path = join(configDir, '.happier-claude-connected-service-home.json');
    renameGate.fail = Object.assign(new Error('injected EACCES at provenance publication'), { code: 'EACCES' });
    const writer = startSharedConsumer({ profileId: 'a', generation: 4, credentialRevision: revB }, fence, 'shared-capture-same-member-b');
    writer.releaseNotification();
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The proof that A is current was taken while A was the home's only publication.
    expect(await readFile(credentialsPath, 'utf8')).toBe(aCredentials);
    resume();
    const first = await readerFirst.consumption;
    expect(first.acknowledgeable).toBe(true);
    expect(readerFirst.notified).toHaveLength(1);
    expect(readerFirst.applyCalls()).toBe(0);
    expect((await writer.consumption as { ok?: boolean }).ok).toBe(false);
    renameGate.fail = null;

    // After the failed publication the home holds B's credentials and no provenance: no proof.
    expect(await readFile(credentialsPath, 'utf8')).not.toBe(aCredentials);
    const after = startAdoptingConsumer('after-failure');
    const second = await after.consumption;
    expect(second.acknowledgeable).toBe(false);
    expect(after.notified).toHaveLength(0);
    expect(after.applyCalls()).toBe(1);
  });
});
