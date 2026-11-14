import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { ConnectedServiceAuthGroupGenerationConsumer } from '@/daemon/connectedServices/accountGroups/generation/ConnectedServiceAuthGroupGenerationConsumer';
import { createSharedGenerationApplication } from '@/daemon/connectedServices/accountGroups/generation/createSharedGenerationApplication';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { buildConnectedServiceAuthGroupCommittedGenerationFact } from '@/daemon/connectedServices/sessionAuthSwitch/connectedServiceAuthSwitchOutcome';

import { applyClaudeSharedGroupGenerationApplication } from './applyClaudeSharedGroupGenerationApplication';
import { ClaudeConnectedServiceAuthGroupRequestFence } from './claudeConnectedServiceAuthGroupRequestFence';
import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './nativeAuth/claudeCodeCredentialScopes';
import { resolveClaudeConnectedServiceStableConfigDir } from './resolveClaudeConnectedServiceStableAuthDir';
import { captureClaudeRuntimeAuthRequestIdentity, surfaceClaudeRateLimitRuntimeIssue } from './surfaceClaudeRuntimeIssues';

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
vi.mock('@/daemon/controlClient', () => ({
  notifyDaemonConnectedServiceRuntimeAuthFailure: notifyFailure,
  notifyDaemonConnectedServiceQuotaSnapshot: vi.fn(async () => ({ ok: true })),
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
});
