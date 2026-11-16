// Per-session softmax connected-service account selection: multi-process acceptance (spec
// happier-selection-b6573fb3 revision 5, Appendix C.2; first part: T1, T2 subset, T11 subset,
// T21 server validation, T23 parameter validation).
//
// Real server routes (server-light), real daemon spawn path, real session runners and Agent SDK
// launcher. Only the Claude executable (fake Claude) and the OAuth token endpoint are fixtures; no
// provider is contacted. Provider adoption is attested the way Claude attests it: the fake Claude
// appends `credential_org` transcript attachments naming the organization of the access token it
// actually read from its materialized `.credentials.json`.
//
// Build under test: when HAPPIER_E2E_PER_SESSION_CLI_SNAPSHOT_DIR names a prepared CLI dist snapshot
// (for example `package-dist` + `node_modules` of an installed release beside a
// `.cli-dist-snapshot.ready.json` marker), the daemon and every runner it spawns run that exact
// build, and the suite asserts the runners' entrypoint. Otherwise the normal source harness is used.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  CLAUDE_CODE_E2E_OAUTH_SCOPE,
  CLAUDE_SUBSCRIPTION_SERVICE_ID,
  asRecord,
  createConnectedServiceProfile,
  requestConnectedClaudeSessionSpawn,
  resolvePreparedCliSnapshotEntrypoint,
  spawnConnectedClaudeSession,
  startConnectedServiceRecoveryTokenServer,
  startConnectedServicesClaudeDaemon,
  type ConnectedServiceRecoveryTokenServer,
  type StartedConnectedServicesClaudeDaemonFixture,
} from '../../src/testkit/connectedServicesRecovery';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { decryptLegacyBase64Normalized } from '../../src/testkit/decryptLegacyBase64Normalized';
import { fakeClaudeFixturePath, readFakeClaudeLogEvents } from '../../src/testkit/fakeClaude';
import { fetchJson } from '../../src/testkit/http';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';
import { enqueueEncryptedUiTextMessage } from '../../src/testkit/uiMessages';

type UnknownRecord = Record<string, unknown>;

const run = createRunDirs({ runLabel: 'core' });
const cliSnapshotDir = process.env.HAPPIER_E2E_PER_SESSION_CLI_SNAPSHOT_DIR?.trim() || undefined;

const SOFTMAX_FEATURE_ENV = { HAPPIER_FEATURE_CONNECTED_SERVICES_POOL_PER_SESSION_SOFTMAX__ENABLED: '1' };
const CAPABILITY_QUERY = 'happierPoolPerSessionSoftmax=1';
const DEFAULT_TEMPERATURE = 1.5;
const DEFAULT_OFFSET_PERCENT = 10;

// Members of the per-session pool, a non-member, and the shared (non per-session) pool's members.
const POOL_MEMBERS = ['alpha', 'beta', 'gamma'] as const;
const DISABLED_MEMBER = 'dormant';
const NON_MEMBER = 'outsider';
const SHARED_MEMBERS = ['solo-a', 'solo-b'] as const;
const ALL_CLAUDE_PROFILES = [...POOL_MEMBERS, DISABLED_MEMBER, NON_MEMBER, ...SHARED_MEMBERS];

const accessTokenOf = (profileId: string) => `access-${profileId}`;
const organizationOf = (profileId: string) => `org-${profileId}`;
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function authHeaders(fixture: StartedConnectedServicesClaudeDaemonFixture, json = false): Record<string, string> {
  return {
    Authorization: `Bearer ${fixture.auth.token}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function serverRequest(
  fixture: StartedConnectedServicesClaudeDaemonFixture,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<{ status: number; data: UnknownRecord }> {
  const response = await fetchJson<UnknownRecord>(`${fixture.serverBaseUrl}${path}`, {
    method,
    headers: authHeaders(fixture, body !== undefined),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    timeoutMs: 20_000,
  });
  return { status: response.status, data: asRecord(response.data) ?? {} };
}

function groupsPath(serviceId: string, groupId?: string, withCapability = true): string {
  const base = `/v3/connect/${serviceId}/groups${groupId ? `/${groupId}` : ''}`;
  return withCapability ? `${base}?${CAPABILITY_QUERY}` : base;
}

async function createGroup(
  fixture: StartedConnectedServicesClaudeDaemonFixture,
  params: Readonly<{
    serviceId?: string;
    groupId: string;
    members: ReadonlyArray<Readonly<{ profileId: string; enabled?: boolean }>>;
    activeProfileId?: string;
    policy: UnknownRecord;
  }>,
): Promise<{ status: number; data: UnknownRecord }> {
  return await serverRequest(fixture, 'POST', groupsPath(params.serviceId ?? CLAUDE_SUBSCRIPTION_SERVICE_ID), {
    groupId: params.groupId,
    members: params.members.map((member, index) => ({ ...member, priority: (index + 1) * 10 })),
    ...(params.activeProfileId ? { activeProfileId: params.activeProfileId } : {}),
    policy: params.policy,
  });
}

async function readGroup(
  fixture: StartedConnectedServicesClaudeDaemonFixture,
  groupId: string,
  withCapability = true,
): Promise<UnknownRecord> {
  const response = await serverRequest(fixture, 'GET', groupsPath(CLAUDE_SUBSCRIPTION_SERVICE_ID, groupId, withCapability));
  const group = asRecord(response.data.group);
  if (response.status !== 200 || !group) throw new Error(`GET group ${groupId} failed: ${response.status} ${JSON.stringify(response.data)}`);
  return group;
}

type ReservationRow = Readonly<{ decisionId: string; profileId: string; sessionId: string; state: string; ownerMachineId: string }>;

async function readReservations(fixture: StartedConnectedServicesClaudeDaemonFixture, groupId: string): Promise<{
  reservationRevision: number;
  reservations: ReservationRow[];
}> {
  const response = await serverRequest(fixture, 'GET', `/v3/connect/${CLAUDE_SUBSCRIPTION_SERVICE_ID}/groups/${groupId}/assignment-reservations`);
  if (response.status !== 200) throw new Error(`GET reservations failed: ${response.status} ${JSON.stringify(response.data)}`);
  return {
    reservationRevision: Number(response.data.reservationRevision),
    reservations: (Array.isArray(response.data.reservations) ? response.data.reservations : []) as ReservationRow[],
  };
}

/** The session's committed connected-service binding for claude-subscription (server session metadata). */
async function readSessionBinding(fixture: StartedConnectedServicesClaudeDaemonFixture, sessionId: string): Promise<UnknownRecord | null> {
  const session = await fetchSessionV2(fixture.serverBaseUrl, fixture.auth.token, sessionId);
  const metadata = asRecord(decryptLegacyBase64Normalized(session.metadata, fixture.accountSecret));
  const bindings = asRecord(asRecord(metadata?.connectedServices)?.bindingsByServiceId);
  return asRecord(bindings?.[CLAUDE_SUBSCRIPTION_SERVICE_ID]);
}

/** The decrypted server session metadata. */
async function readSessionMetadata(fixture: StartedConnectedServicesClaudeDaemonFixture, sessionId: string): Promise<UnknownRecord | null> {
  const session = await fetchSessionV2(fixture.serverBaseUrl, fixture.auth.token, sessionId);
  return asRecord(decryptLegacyBase64Normalized(session.metadata, fixture.accountSecret));
}

/** Lines of this daemon's own log files containing `needle`. */
async function daemonLogLinesContaining(fixture: StartedConnectedServicesClaudeDaemonFixture, needle: string): Promise<string[]> {
  const logsDir = resolve(fixture.daemonHomeDir, 'logs');
  const lines: string[] = [];
  for (const name of await readdir(logsDir).catch(() => [] as string[])) {
    if (!name.endsWith('-daemon.log')) continue;
    const text = await readFile(resolve(logsDir, name), 'utf8').catch(() => '');
    lines.push(...text.split('\n').filter((line) => line.includes(needle)));
  }
  return lines;
}

/** This daemon's durable per-session decision ledger (spec A.3, A.5). */
async function readLedgerEntry(fixture: StartedConnectedServicesClaudeDaemonFixture, decisionId: string): Promise<UnknownRecord | null> {
  const path = resolve(fixture.daemonHomeDir, 'servers', fixture.serverId, 'connected-services', 'per-session-assignments.json');
  try {
    const snapshot = asRecord(JSON.parse(await readFile(path, 'utf8')) as unknown);
    return asRecord(asRecord(snapshot?.entriesByDecisionId)?.[decisionId]);
  } catch {
    return null;
  }
}

async function listRunnerPids(fixture: StartedConnectedServicesClaudeDaemonFixture): Promise<Map<string, number>> {
  const listed = await daemonControlPostJson<{ children?: Array<{ happySessionId?: string; pid?: number }> }>({
    port: fixture.daemonPort, path: '/list', controlToken: fixture.controlToken, body: {},
  });
  const pids = new Map<string, number>();
  for (const child of listed.data.children ?? []) {
    if (typeof child.happySessionId === 'string' && typeof child.pid === 'number') pids.set(child.happySessionId, child.pid);
  }
  return pids;
}

async function readProcessArgv(pid: number): Promise<string[]> {
  return (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
}

/** Whether a process runs the prepared snapshot's entrypoint (compared by real path). */
async function runsSnapshotEntrypoint(argv: ReadonlyArray<string>, snapshotDir: string): Promise<boolean> {
  const expected = await realpath(resolvePreparedCliSnapshotEntrypoint(snapshotDir));
  for (const arg of argv) {
    if (!arg.endsWith('.mjs')) continue;
    if (await realpath(arg).then((actual) => actual === expected, () => false)) return true;
  }
  return false;
}

function expectSpawnRefusal(
  response: Awaited<ReturnType<typeof requestConnectedClaudeSessionSpawn>>,
  code: string,
): void {
  expect(response.data.success, JSON.stringify(response.data)).not.toBe(true);
  expect(response.status).not.toBe(200);
  expect(String(response.data.error ?? '')).toContain(code);
}

describe('core e2e: per-session softmax connected-service account selection', () => {
  let fixture: StartedConnectedServicesClaudeDaemonFixture | null = null;
  let tokenServer: ConnectedServiceRecoveryTokenServer | null = null;
  let t1Sessions: { groupId: string; sessions: Array<{ sessionId: string; initialProfileId: string; decisionId: string }> } | null = null;
  const fx = (): StartedConnectedServicesClaudeDaemonFixture => {
    if (!fixture) throw new Error('per-session fixture not started');
    return fixture;
  };
  const credentialOrgByAccessToken = Object.fromEntries(ALL_CLAUDE_PROFILES.map((id) => [accessTokenOf(id), organizationOf(id)]));
  const fakeClaudeEnv = {
    HAPPIER_E2E_FAKE_CLAUDE_ALLOW_ACCESS_ONLY_NATIVE_OAUTH: '1',
    HAPPIER_E2E_FAKE_CLAUDE_CREDENTIAL_ORG_BY_ACCESS_TOKEN: JSON.stringify(credentialOrgByAccessToken),
    // Runner logs are this suite's diagnostic record of the adoption path.
    HAPPIER_LOG_LEVEL: 'debug',
  };

  beforeAll(async () => {
    const testDir = run.testDir('connected-services-per-session-softmax');
    tokenServer = await startConnectedServiceRecoveryTokenServer({
      respond: () => ({ status: 400, body: { error: 'invalid_grant' } }),
    });
    fixture = await startConnectedServicesClaudeDaemon({
      testDir,
      testName: 'connected-services-per-session-softmax',
      tokenUrl: tokenServer.tokenUrl,
      fakeClaudePath: fakeClaudeFixturePath(),
      fakeClaudeLogPath: resolve(testDir, 'fake-claude.jsonl'),
      // Agent SDK runner, as in the Claude usage-limit suite.
      accountSettings: { claudeUnifiedTerminalEnabled: false },
      serverExtraEnv: SOFTMAX_FEATURE_ENV,
      extraEnv: { ...SOFTMAX_FEATURE_ENV, ...fakeClaudeEnv },
      ...(cliSnapshotDir ? { cliSnapshotDir } : {}),
    });
    for (const profileId of ALL_CLAUDE_PROFILES) {
      await createConnectedServiceProfile({
        fixture, serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID, profileId,
        providerEmail: `${profileId}@example.test`, idToken: null,
        accessToken: accessTokenOf(profileId), refreshToken: `refresh-${profileId}`,
        scope: CLAUDE_CODE_E2E_OAUTH_SCOPE, tokenType: 'Bearer',
        providerAccountId: `acct-${profileId}`, expiresAt: Date.now() + 3600_000,
        oauthRaw: { claudeAiOauth: { organizationUuid: organizationOf(profileId), subscriptionType: 'max' } },
      });
    }
    await createConnectedServiceProfile({
      fixture, serviceId: 'openai-codex', profileId: 'codex-work', providerEmail: 'codex-work@example.test',
    });
  }, 300_000);

  afterAll(async () => {
    await fixture?.daemon.stop().catch(() => {});
    await fixture?.server.stop().catch(() => {});
    await tokenServer?.stop().catch(() => {});
    fixture = null;
    tokenServer = null;
  }, 120_000);

  it('T1: two named starts land on their own members; the shared pointer and generation do not move', async () => {
    const f = fx();
    const groupId = 'spread-t1';
    // The shared pointer names a third member, so neither session can reach its member through it.
    const created = await createGroup(f, {
      groupId,
      members: POOL_MEMBERS.map((profileId) => ({ profileId })),
      activeProfileId: 'gamma',
      policy: { strategy: 'per_session_softmax', autoSwitch: true, recoveryMode: 'switch_or_wait' },
    });
    expect(created.status, JSON.stringify(created.data)).toBe(200);
    const createdGroup = asRecord(created.data.group)!;
    expect(createdGroup.activeProfileId).toBe('gamma');
    expect(asRecord(createdGroup.policy)).toMatchObject({ strategy: 'per_session_softmax' });
    const generationBefore = createdGroup.generation;

    const requested = [
      { sessionId: randomUUID(), initialProfileId: 'alpha' },
      { sessionId: randomUUID(), initialProfileId: 'beta' },
    ] as const;
    const sessions: Array<{ sessionId: string; initialProfileId: string; decisionId: string }> = [];
    for (const request of requested) {
      const sessionId = await spawnConnectedClaudeSession({
        fixture: f, sessionId: request.sessionId, groupId, initialProfileId: request.initialProfileId,
        extraEnvironmentVariables: fakeClaudeEnv,
      });
      // Child creation records only the pending target (materializedAssignment); `member` is absent
      // until the provider attests the account (spec A.5 C4/C5, T19).
      let binding: UnknownRecord | null = null;
      await waitFor(async () => {
        binding = await readSessionBinding(f, sessionId);
        return asRecord(binding?.materializedAssignment) !== null;
      }, { timeoutMs: 30_000, context: `materialized assignment committed for ${request.initialProfileId}` });
      const materialized = asRecord(binding!.materializedAssignment)!;
      expect(binding).toMatchObject({ selection: 'group', groupId, initialProfileId: request.initialProfileId });
      expect(binding).not.toHaveProperty('member');
      // An explicit start is not a weighted draw (T23): no probability; default τ/δ recorded.
      expect(materialized).toMatchObject({
        profileId: request.initialProfileId,
        reason: 'initial_requested',
        temperature: DEFAULT_TEMPERATURE,
        offsetPercent: DEFAULT_OFFSET_PERCENT,
      });
      expect(materialized).not.toHaveProperty('probability');
      const decisionId = String(materialized.decisionId);
      const pendingLedger = await readLedgerEntry(f, decisionId);
      expect(pendingLedger).toMatchObject({ decisionId, groupId, origin: 'spawn', state: 'pending' });
      expect(asRecord(pendingLedger?.proposal)).toMatchObject({ profileId: request.initialProfileId });
      sessions.push({ sessionId, initialProfileId: request.initialProfileId, decisionId });
    }
    expect(new Set(sessions.map((session) => session.decisionId)).size).toBe(2);

    // Pending reservations are visible on the server before any provider activity.
    const pendingRows = (await readReservations(f, groupId)).reservations;
    for (const session of sessions) {
      expect(pendingRows.find((row) => row.decisionId === session.decisionId)).toMatchObject({
        profileId: session.initialProfileId, state: 'pending', ownerMachineId: f.machineId,
      });
    }

    // Drive one provider turn per session; the fake Claude attests its credential's organization.
    for (const session of sessions) {
      await enqueueEncryptedUiTextMessage({
        baseUrl: f.serverBaseUrl, token: f.auth.token, secret: f.accountSecret,
        sessionId: session.sessionId, text: `PER_SESSION_T1_${session.initialProfileId}_${randomUUID()}`,
      });
    }

    // Provider-side evidence: each session's provider process read its own member's credential from
    // that member's profile home, never the group home; the shared pointer's member was never used.
    const attestationsFor = async (profileId: string): Promise<UnknownRecord[]> =>
      ((await readFakeClaudeLogEvents(f.fakeClaudeLogPath)) as UnknownRecord[]).filter((event) => (
        event.type === 'credential_org_attachment' && event.emitted === true
        && event.accessTokenSha256 === sha256(accessTokenOf(profileId))
      ));
    for (const session of sessions) {
      // All scheduled attestations of the turn (fixture emits three per turn).
      await waitFor(async () => (await attestationsFor(session.initialProfileId)).length >= 3, {
        timeoutMs: 60_000, context: `provider turn and credential_org attestations for ${session.initialProfileId}`,
      });
      for (const event of await attestationsFor(session.initialProfileId)) {
        expect(event.organizationUuid).toBe(organizationOf(session.initialProfileId));
        const configDir = String(event.claudeConfigDir);
        expect(configDir).not.toContain('__groups');
        expect(configDir).toContain(`/homes/${CLAUDE_SUBSCRIPTION_SERVICE_ID}/${session.initialProfileId}/`);
      }
    }
    expect((await attestationsFor('gamma')).length).toBe(0);

    // The shared pointer and generation are unchanged by per-session assignment.
    const after = await readGroup(f, groupId);
    expect(after.activeProfileId).toBe('gamma');
    expect(after.generation).toBe(generationBefore);

    // The runners are the build under test.
    const pids = await listRunnerPids(f);
    for (const session of sessions) {
      const pid = pids.get(session.sessionId);
      expect(pid, `runner for ${session.sessionId}`).toBeTypeOf('number');
      if (cliSnapshotDir) {
        const argv = await readProcessArgv(pid!);
        expect(await runsSnapshotEntrypoint(argv, cliSnapshotDir), `runner argv ${JSON.stringify(argv)}`).toBe(true);
      }
    }
    if (cliSnapshotDir) {
      const daemonArgv = await readProcessArgv(f.daemon.state.pid);
      expect(await runsSnapshotEntrypoint(daemonArgv, cliSnapshotDir), `daemon argv ${JSON.stringify(daemonArgv)}`).toBe(true);
    }
    t1Sessions = { groupId, sessions };
  }, 300_000);

  // The per-session runner is launched with its member's profile selection; its observed provider
  // organization is reported against the session binding's group, which adopts the pending target.
  // Without that report no member is ever applied (the deployed c4brq5xx build fails this test).
  it('T1/T19: provider adoption promotes each pending target to the applied member', async () => {
    const f = fx();
    if (!t1Sessions) throw new Error('T1 did not record its sessions');
    const { groupId, sessions } = t1Sessions;
    for (const session of sessions) {
      await waitFor(async () => {
        const member = asRecord((await readSessionBinding(f, session.sessionId))?.member);
        const ledger = await readLedgerEntry(f, session.decisionId);
        return member?.profileId === session.initialProfileId && ledger?.state === 'applied';
      }, { timeoutMs: 20_000, context: `provider adoption applies ${session.initialProfileId}` });
      expect(asRecord((await readSessionBinding(f, session.sessionId))!.member)).toMatchObject({
        profileId: session.initialProfileId, decisionId: session.decisionId, reason: 'initial_requested',
      });
    }
    // Adoption records the ledger first, then renews the shared reservation as applied.
    await waitFor(async () => {
      const rows = (await readReservations(f, groupId)).reservations;
      return sessions.every((session) => rows.some((row) => (
        row.decisionId === session.decisionId && row.state === 'applied'
      )));
    }, { timeoutMs: 20_000, context: 'adopted reservations renewed as applied' });
    const rows = (await readReservations(f, groupId)).reservations;
    for (const session of sessions) {
      expect(rows.find((row) => row.decisionId === session.decisionId)).toMatchObject({
        profileId: session.initialProfileId, state: 'applied',
      });
    }
    const after = await readGroup(f, groupId);
    expect(after.activeProfileId).toBe('gamma');
  }, 60_000);

  // R15-HOME-PROOF-01 / R15-STALE-PROOF-02, through the real daemon route and its durable launch
  // custody. The session's own fake Claude attests nothing, so every report below is the test's, sent
  // the way a runner sends it; only evidence from the current runner for the decision launched in it,
  // on the home that decision materialized, may adopt the pending target (spec A.5 C4, T18/T19).
  it('R15: provider evidence adopts a pending target only with the current runner\'s own launch provenance', async () => {
    const f = fx();
    const groupId = 'provenance-r15';
    const created = await createGroup(f, {
      groupId,
      members: POOL_MEMBERS.map((profileId) => ({ profileId })),
      activeProfileId: 'gamma',
      policy: { strategy: 'per_session_softmax', autoSwitch: true, recoveryMode: 'switch_or_wait' },
    });
    expect(created.status, JSON.stringify(created.data)).toBe(200);
    const silentClaudeEnv = { ...fakeClaudeEnv, HAPPIER_E2E_FAKE_CLAUDE_CREDENTIAL_ORG_BY_ACCESS_TOKEN: '{}' };
    const sessionId = await spawnConnectedClaudeSession({
      fixture: f, sessionId: randomUUID(), groupId, initialProfileId: 'alpha', extraEnvironmentVariables: silentClaudeEnv,
    });
    let decisionId = '';
    await waitFor(async () => {
      decisionId = String(asRecord((await readSessionBinding(f, sessionId))?.materializedAssignment)?.decisionId ?? '');
      return decisionId.length > 0;
    }, { timeoutMs: 30_000, context: 'pending target committed' });
    await enqueueEncryptedUiTextMessage({
      baseUrl: f.serverBaseUrl, token: f.auth.token, secret: f.accountSecret,
      sessionId, text: `PER_SESSION_R15_${randomUUID()}`,
    });
    let nativeSessionId = '';
    await waitFor(async () => {
      nativeSessionId = String((await readSessionMetadata(f, sessionId))?.claudeSessionId ?? '');
      return nativeSessionId.length > 0;
    }, { timeoutMs: 60_000, context: 'native Claude session recorded' });
    const runnerPid = (await listRunnerPids(f)).get(sessionId);
    expect(runnerPid).toBeTypeOf('number');
    // Launch custody: the ledger names the runner the decision was launched in.
    expect(asRecord((await readLedgerEntry(f, decisionId))?.launchedRunner)).toMatchObject({ pid: runnerPid });

    const report = async (provenance: Readonly<{ runnerPid?: number; launchHome?: 'group' | 'member' }>) => {
      const response = await daemonControlPostJson<UnknownRecord>({
        port: f.daemonPort, path: '/connected-service-turn-lifecycle', controlToken: f.controlToken,
        body: {
          sessionId, event: 'provider_identity_observed',
          providerIdentity: {
            serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID, groupId, providerOrganizationId: organizationOf('alpha'),
            observedAtMs: Date.now(), sourceSessionId: nativeSessionId, ...provenance,
          },
        },
        timeoutMs: 30_000,
      });
      expect(response.status, JSON.stringify(response.data)).toBe(200);
    };
    const expectStillPending = async () => {
      const binding = await readSessionBinding(f, sessionId);
      expect(binding).not.toHaveProperty('member');
      expect(asRecord(binding?.materializedAssignment)).toMatchObject({ decisionId, profileId: 'alpha' });
      expect(await readLedgerEntry(f, decisionId)).toMatchObject({ state: 'pending' });
    };

    // A process other than the current runner (a replaced runner's delayed report) is rejected.
    await report({ runnerPid: runnerPid! + 1_000_000, launchHome: 'member' });
    await waitFor(async () => (
      await daemonLogLinesContaining(f, 'provider_session_account_observation_runner_not_current')
    ).some((line) => line.includes(sessionId)), { timeoutMs: 20_000, context: 'stale-runner report rejected' });
    await expectStillPending();
    expect(await readSessionBinding(f, sessionId)).not.toHaveProperty('appliedProfileId');

    // Evidence without provenance (an older runner build) is published as account evidence only.
    await report({});
    await waitFor(async () => (await readSessionBinding(f, sessionId))?.appliedProfileId === 'alpha',
      { timeoutMs: 20_000, context: 'unqualified evidence published' });
    await expectStillPending();

    // The current runner's report for the member home its decision was launched on adopts it.
    await report({ runnerPid: runnerPid!, launchHome: 'member' });
    await waitFor(async () => {
      const member = asRecord((await readSessionBinding(f, sessionId))?.member);
      return member?.decisionId === decisionId && (await readLedgerEntry(f, decisionId))?.state === 'applied';
    }, { timeoutMs: 20_000, context: 'current runner evidence adopts its launched decision' });
    expect(asRecord((await readSessionBinding(f, sessionId))?.member)).toMatchObject({ profileId: 'alpha', decisionId });
  }, 180_000);

  // T7 (first part) through the real runtime-auth failure route: a usage-limit failure on one
  // session's member draws a new per-session decision and restarts only that session onto the new
  // member's own home with the same native resume id; its provider adoption applies the new member.
  // Other sessions and the shared pointer are untouched (spec A.4, A.5 C1–C5).
  it('T7: a usage-limit failure restarts only that session onto another member, resuming the same native session', async () => {
    const f = fx();
    const groupId = 'failover-t7';
    const created = await createGroup(f, {
      groupId,
      members: POOL_MEMBERS.map((profileId) => ({ profileId })),
      activeProfileId: 'gamma',
      policy: { strategy: 'per_session_softmax', autoSwitch: true, recoveryMode: 'switch_or_wait' },
    });
    expect(created.status, JSON.stringify(created.data)).toBe(200);
    const generationBefore = asRecord(created.data.group)!.generation;
    const start = async (initialProfileId: string) => {
      const sessionId = await spawnConnectedClaudeSession({
        fixture: f, sessionId: randomUUID(), groupId, initialProfileId, extraEnvironmentVariables: fakeClaudeEnv,
      });
      await enqueueEncryptedUiTextMessage({
        baseUrl: f.serverBaseUrl, token: f.auth.token, secret: f.accountSecret,
        sessionId, text: `PER_SESSION_T7_${initialProfileId}_${randomUUID()}`,
      });
      await waitFor(async () => asRecord((await readSessionBinding(f, sessionId))?.member)?.profileId === initialProfileId,
        { timeoutMs: 60_000, context: `initial adoption on ${initialProfileId}` });
      return sessionId;
    };
    const failing = await start('alpha');
    const bystander = await start('beta');
    const pidsBefore = await listRunnerPids(f);
    const nativeSessionId = String((await readSessionMetadata(f, failing))?.claudeSessionId ?? '');
    expect(nativeSessionId.length).toBeGreaterThan(0);
    const appliedBefore = asRecord((await readSessionBinding(f, failing))?.member)!;

    const failure = await daemonControlPostJson<UnknownRecord>({
      port: f.daemonPort, path: '/connected-service-runtime-auth/failure', controlToken: f.controlToken,
      body: {
        sessionId: failing, switchesThisTurn: 0,
        classification: {
          kind: 'usage_limit', limitCategory: 'quota', serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID, profileId: 'alpha', groupId,
          resetsAtMs: Date.now() + 3_600_000, retryAfterMs: 3_600_000, quotaScope: 'account', providerLimitId: 'weekly',
          action: null, planType: null, rateLimits: null, source: 'structured_provider_error',
        },
      },
      timeoutMs: 120_000,
    });
    expect(failure.status, JSON.stringify(failure.data)).toBe(200);
    expect(JSON.stringify(failure.data)).not.toContain('recovery_terminal');

    // The new decision is materialized for this session only, on another member.
    let target = '';
    await waitFor(async () => {
      const pending = asRecord((await readSessionBinding(f, failing))?.materializedAssignment);
      target = String(pending?.profileId ?? '');
      return target.length > 0;
    }, { timeoutMs: 30_000, context: 'failover target materialized' });
    expect(target).not.toBe('alpha');

    // The runner is restarted (a new process) onto the target member's own home, resuming the same native session.
    await waitFor(async () => {
      const pid = (await listRunnerPids(f)).get(failing);
      return typeof pid === 'number' && pid !== pidsBefore.get(failing);
    }, { timeoutMs: 60_000, context: 'failing session runner restarted' });
    await enqueueEncryptedUiTextMessage({
      baseUrl: f.serverBaseUrl, token: f.auth.token, secret: f.accountSecret,
      sessionId: failing, text: `PER_SESSION_T7_after_${randomUUID()}`,
    });
    await waitFor(async () => {
      const member = asRecord((await readSessionBinding(f, failing))?.member);
      return member?.profileId === target && member.decisionId !== appliedBefore.decisionId;
    }, { timeoutMs: 90_000, context: `adoption of failover target ${target}` });
    const invocations = ((await readFakeClaudeLogEvents(f.fakeClaudeLogPath)) as UnknownRecord[])
      .filter((event) => event.type === 'invocation' && String(event.claudeConfigDir ?? '').includes(`/claude-subscription/${target}/`));
    const resumedSession = (argv: unknown): string | null => {
      if (!Array.isArray(argv)) return null;
      const index = argv.indexOf('--resume');
      return index >= 0 && typeof argv[index + 1] === 'string' ? argv[index + 1] : null;
    };
    expect(invocations.some((event) => resumedSession(event.argv) === nativeSessionId),
      `an invocation on ${target}'s home resumes ${nativeSessionId}: ${JSON.stringify(invocations.map((event) => event.argv))}`).toBe(true);

    // Only the failing session moved; the shared pointer and generation did not.
    expect((await listRunnerPids(f)).get(bystander)).toBe(pidsBefore.get(bystander));
    expect(asRecord((await readSessionBinding(f, bystander))?.member)?.profileId).toBe('beta');
    const groupAfter = await readGroup(f, groupId);
    expect(groupAfter.activeProfileId).toBe('gamma');
    expect(groupAfter.generation).toBe(generationBefore);
  }, 300_000);

  // T12: rolling the policy back causes no immediate restart; per-session ownership stays until the
  // next failure converts the session, and only provider adoption through the group's shared home
  // (the converted runner's own launch) ends it (spec A.4 Migration, C3′/C4).
  it('T12: policy rollback keeps the session until a failure converts it through the group home', async () => {
    const f = fx();
    const groupId = 'rollback-t12';
    const created = await createGroup(f, {
      groupId,
      members: POOL_MEMBERS.map((profileId) => ({ profileId })),
      activeProfileId: 'gamma',
      policy: { strategy: 'per_session_softmax', autoSwitch: true, recoveryMode: 'switch_or_wait' },
    });
    expect(created.status, JSON.stringify(created.data)).toBe(200);
    // The provider's own usage-limit failure, on the turn after this file appears.
    const usageLimitSignal = resolve(f.daemonHomeDir, `usage-limit-${randomUUID()}.signal`);
    const sessionId = await spawnConnectedClaudeSession({
      fixture: f, sessionId: randomUUID(), groupId, initialProfileId: 'alpha',
      extraEnvironmentVariables: { ...fakeClaudeEnv, HAPPIER_E2E_FAKE_CLAUDE_USAGE_LIMIT_SIGNAL: usageLimitSignal },
    });
    const turn = async (label: string) => await enqueueEncryptedUiTextMessage({
      baseUrl: f.serverBaseUrl, token: f.auth.token, secret: f.accountSecret, sessionId, text: `PER_SESSION_T12_${label}_${randomUUID()}`,
    });
    await turn('initial');
    await waitFor(async () => asRecord((await readSessionBinding(f, sessionId))?.member)?.profileId === 'alpha',
      { timeoutMs: 60_000, context: 'initial adoption on alpha' });
    const pidBefore = (await listRunnerPids(f)).get(sessionId);
    const appliedDecisionId = String(asRecord((await readSessionBinding(f, sessionId))?.member)?.decisionId);

    const current = await readGroup(f, groupId);
    const rollback = await serverRequest(f, 'PATCH', groupsPath(CLAUDE_SUBSCRIPTION_SERVICE_ID, groupId), {
      expectedGeneration: current.generation, policy: { strategy: 'priority' },
    });
    expect(rollback.status, JSON.stringify(rollback.data)).toBe(200);

    // A turn after rollback is served by the same runner on the same member.
    // Each served turn attests its account from the home it ran on.
    const invocationsOnAlpha = async () => ((await readFakeClaudeLogEvents(f.fakeClaudeLogPath)) as UnknownRecord[])
      .filter((event) => event.type === 'credential_org_attachment' && event.emitted === true
        && String(event.claudeConfigDir ?? '').includes('/claude-subscription/alpha/')).length;
    const alphaInvocationsBefore = await invocationsOnAlpha();
    await turn('after-rollback');
    await waitFor(async () => (await invocationsOnAlpha()) > alphaInvocationsBefore,
      { timeoutMs: 60_000, context: 'turn after rollback served on alpha' });
    expect((await listRunnerPids(f)).get(sessionId)).toBe(pidBefore);
    expect(asRecord((await readSessionBinding(f, sessionId))?.member)).toMatchObject({ profileId: 'alpha', decisionId: appliedDecisionId });

    // The next provider failure (a real usage-limit result of the served turn) converts the session
    // to the group's shared home.
    await writeFile(usageLimitSignal, 'fail next turn\n', 'utf8');
    await turn('usage-limit');
    await waitFor(async () => {
      const pid = (await listRunnerPids(f)).get(sessionId);
      return typeof pid === 'number' && pid !== pidBefore;
    }, { timeoutMs: 60_000, context: 'converting session restarted' });
    await turn('after-conversion');
    // Adoption through the group home ends per-session ownership.
    let converted: UnknownRecord | null = null;
    await waitFor(async () => {
      converted = await readSessionBinding(f, sessionId);
      return converted !== null && !('member' in converted) && !('materializedAssignment' in converted)
        && typeof converted.appliedProfileId === 'string';
    }, { timeoutMs: 90_000, context: 'conversion proved through the group home' });
    expect(converted!.appliedProfileId).not.toBe('alpha');
    const groupHomeInvocations = ((await readFakeClaudeLogEvents(f.fakeClaudeLogPath)) as UnknownRecord[])
      .filter((event) => event.type === 'invocation' && String(event.claudeConfigDir ?? '').includes(`/__groups/${groupId}/`));
    expect(groupHomeInvocations.length, 'the converted runner runs on the group home').toBeGreaterThan(0);
    // The per-session decisions it retired are released.
    await waitFor(async () => !(await readReservations(f, groupId)).reservations.some((row) => row.sessionId === sessionId
      || row.decisionId === appliedDecisionId), { timeoutMs: 30_000, context: 'per-session reservations released' });
  }, 300_000);

  // T7 driven by the provider itself: the served turn fails with a real usage-limit result, which the
  // runner reports through its own runtime-auth path (source verification included).
  it('T7 (provider failure): a real usage-limit turn failure moves only that session to another member', async () => {
    const f = fx();
    const groupId = 'failover-t7-real';
    const created = await createGroup(f, {
      groupId,
      members: POOL_MEMBERS.map((profileId) => ({ profileId })),
      activeProfileId: 'gamma',
      policy: { strategy: 'per_session_softmax', autoSwitch: true, recoveryMode: 'switch_or_wait' },
    });
    expect(created.status, JSON.stringify(created.data)).toBe(200);
    const usageLimitSignal = resolve(f.daemonHomeDir, `usage-limit-${randomUUID()}.signal`);
    const sessionId = await spawnConnectedClaudeSession({
      fixture: f, sessionId: randomUUID(), groupId, initialProfileId: 'alpha',
      extraEnvironmentVariables: { ...fakeClaudeEnv, HAPPIER_E2E_FAKE_CLAUDE_USAGE_LIMIT_SIGNAL: usageLimitSignal },
    });
    const turn = async (label: string) => await enqueueEncryptedUiTextMessage({
      baseUrl: f.serverBaseUrl, token: f.auth.token, secret: f.accountSecret, sessionId, text: `PER_SESSION_T7R_${label}_${randomUUID()}`,
    });
    await turn('initial');
    await waitFor(async () => asRecord((await readSessionBinding(f, sessionId))?.member)?.profileId === 'alpha',
      { timeoutMs: 60_000, context: 'initial adoption on alpha' });
    const pidBefore = (await listRunnerPids(f)).get(sessionId);
    await writeFile(usageLimitSignal, 'fail next turn\n', 'utf8');
    await turn('usage-limit');
    let target = '';
    await waitFor(async () => {
      const binding = await readSessionBinding(f, sessionId);
      const pending = asRecord(binding?.materializedAssignment);
      const member = asRecord(binding?.member);
      target = String(pending?.profileId ?? (member?.profileId !== 'alpha' ? member?.profileId ?? '' : ''));
      return target.length > 0 && target !== 'alpha';
    }, { timeoutMs: 60_000, context: 'failover decision for the real provider failure' });
    await waitFor(async () => {
      const pid = (await listRunnerPids(f)).get(sessionId);
      return typeof pid === 'number' && pid !== pidBefore;
    }, { timeoutMs: 60_000, context: 'failing session runner restarted' });
    await waitFor(async () => asRecord((await readSessionBinding(f, sessionId))?.member)?.profileId === target,
      { timeoutMs: 90_000, context: `adoption of failover target ${target}` });
  }, 300_000);

  it('T2 (subset): a shared group rejects initialProfileId; configuration-invalid named starts reject', async () => {
    const f = fx();
    const sharedGroupId = 'shared-t2';
    const shared = await createGroup(f, {
      groupId: sharedGroupId,
      members: SHARED_MEMBERS.map((profileId) => ({ profileId })),
      activeProfileId: SHARED_MEMBERS[0],
      policy: { autoSwitch: true, recoveryMode: 'switch_or_wait' },
    });
    expect(shared.status, JSON.stringify(shared.data)).toBe(200);
    expect(asRecord(asRecord(shared.data.group)?.policy)?.strategy).not.toBe('per_session_softmax');
    const sharedRefusal = await requestConnectedClaudeSessionSpawn({
      fixture: f, sessionId: randomUUID(), groupId: sharedGroupId, initialProfileId: SHARED_MEMBERS[1],
      extraEnvironmentVariables: fakeClaudeEnv,
    });
    expectSpawnRefusal(sharedRefusal, 'initial_profile_requires_per_session_group');
    const sharedAfter = await readGroup(f, sharedGroupId);
    expect(sharedAfter.activeProfileId).toBe(SHARED_MEMBERS[0]);
    expect(sharedAfter.generation).toBe(asRecord(shared.data.group)!.generation);

    const groupId = 'spread-t2';
    const created = await createGroup(f, {
      groupId,
      members: [...POOL_MEMBERS.map((profileId) => ({ profileId })), { profileId: DISABLED_MEMBER, enabled: false }],
      activeProfileId: 'alpha',
      policy: { strategy: 'per_session_softmax', softmaxTemperature: DEFAULT_TEMPERATURE, softmaxOffsetPercent: DEFAULT_OFFSET_PERCENT },
    });
    expect(created.status, JSON.stringify(created.data)).toBe(200);
    const before = await readReservations(f, groupId);

    const notMember = await requestConnectedClaudeSessionSpawn({
      fixture: f, sessionId: randomUUID(), groupId, initialProfileId: NON_MEMBER, extraEnvironmentVariables: fakeClaudeEnv,
    });
    expectSpawnRefusal(notMember, 'initial_profile_not_member');
    const disabled = await requestConnectedClaudeSessionSpawn({
      fixture: f, sessionId: randomUUID(), groupId, initialProfileId: DISABLED_MEMBER, extraEnvironmentVariables: fakeClaudeEnv,
    });
    expectSpawnRefusal(disabled, 'initial_profile_disabled');

    // Configuration-invalid starts reject before any reservation or pointer effect.
    const after = await readReservations(f, groupId);
    expect(after.reservationRevision).toBe(before.reservationRevision);
    expect(after.reservations).toEqual(before.reservations);
    const groupAfter = await readGroup(f, groupId);
    expect(groupAfter.activeProfileId).toBe('alpha');
    expect(groupAfter.generation).toBe(asRecord(created.data.group)!.generation);
  }, 180_000);

  it('T21 + T23: the running server validates strategy service support and softmax parameters', async () => {
    const f = fx();
    // T21: non-claude-subscription groups reject the strategy, on create and on patch.
    const codexCreate = await createGroup(f, {
      serviceId: 'openai-codex', groupId: 'codex-spread', members: [{ profileId: 'codex-work' }],
      policy: { strategy: 'per_session_softmax' },
    });
    expect(codexCreate.status).toBe(400);
    expect(codexCreate.data).toEqual({ error: 'connect_group_strategy_unsupported_for_service' });
    const codexGroup = await createGroup(f, {
      serviceId: 'openai-codex', groupId: 'codex-shared', members: [{ profileId: 'codex-work' }],
      policy: { autoSwitch: true },
    });
    expect(codexGroup.status, JSON.stringify(codexGroup.data)).toBe(200);
    const codexPatch = await serverRequest(f, 'PATCH', groupsPath('openai-codex', 'codex-shared'), {
      expectedGeneration: asRecord(codexGroup.data.group)!.generation, policy: { strategy: 'per_session_softmax' },
    });
    expect(codexPatch.status).toBe(400);
    expect(codexPatch.data).toEqual({ error: 'connect_group_strategy_unsupported_for_service' });

    // T23: δ = 0, negative δ, δ above 100 and out-of-range τ are out of range.
    for (const outOfRange of [
      { softmaxOffsetPercent: 0 },
      { softmaxOffsetPercent: -1 },
      { softmaxOffsetPercent: 100.5 },
      { softmaxTemperature: 0 },
      { softmaxTemperature: -1.5 },
      { softmaxTemperature: 0.2 },
      { softmaxTemperature: 11 },
    ]) {
      const response = await createGroup(f, {
        groupId: 'validation-t23', members: [{ profileId: 'alpha' }],
        policy: { strategy: 'per_session_softmax', ...outOfRange },
      });
      expect(response.status, JSON.stringify(outOfRange)).toBe(400);
      expect(response.data, JSON.stringify(outOfRange)).toEqual({ error: 'connect_group_policy_field_out_of_range' });
    }
    // Either field on another strategy (explicit or default) is invalid for that strategy.
    for (const policy of [
      { strategy: 'least_limited', softmaxTemperature: 2 },
      { strategy: 'priority', softmaxOffsetPercent: 10 },
      { softmaxOffsetPercent: 10 },
    ]) {
      const response = await createGroup(f, { groupId: 'validation-t23', members: [{ profileId: 'alpha' }], policy });
      expect(response.status, JSON.stringify(policy)).toBe(400);
      expect(response.data, JSON.stringify(policy)).toEqual({ error: 'connect_group_policy_field_invalid_for_strategy' });
    }
    const missing = await serverRequest(f, 'GET', groupsPath(CLAUDE_SUBSCRIPTION_SERVICE_ID, 'validation-t23'));
    expect(missing.status).toBe(404);

    const sharedGroup = await createGroup(f, {
      groupId: 'shared-t23', members: [{ profileId: 'alpha' }], policy: { autoSwitch: true },
    });
    expect(sharedGroup.status, JSON.stringify(sharedGroup.data)).toBe(200);
    const patch = await serverRequest(f, 'PATCH', groupsPath(CLAUDE_SUBSCRIPTION_SERVICE_ID, 'shared-t23'), {
      expectedGeneration: asRecord(sharedGroup.data.group)!.generation, policy: { softmaxTemperature: 2 },
    });
    expect(patch.status).toBe(400);
    expect(patch.data).toEqual({ error: 'connect_group_policy_field_invalid_for_strategy' });

    // In-range boundary values are accepted and stored as given.
    const accepted = await createGroup(f, {
      groupId: 'bounds-t23', members: [{ profileId: 'alpha' }],
      policy: { strategy: 'per_session_softmax', softmaxTemperature: 0.25, softmaxOffsetPercent: 100 },
    });
    expect(accepted.status, JSON.stringify(accepted.data)).toBe(200);
    expect(asRecord(asRecord(accepted.data.group)?.policy)).toMatchObject({
      strategy: 'per_session_softmax', softmaxTemperature: 0.25, softmaxOffsetPercent: 100,
    });
  }, 120_000);

  it('T11 (subset): readers without the capability see a manual pool and their edits get 409', async () => {
    const f = fx();
    const groupId = 'spread-t11';
    const policy = { strategy: 'per_session_softmax', softmaxTemperature: DEFAULT_TEMPERATURE, softmaxOffsetPercent: DEFAULT_OFFSET_PERCENT };
    const created = await createGroup(f, {
      groupId, members: [{ profileId: 'alpha' }, { profileId: 'beta' }], activeProfileId: 'alpha', policy,
    });
    expect(created.status, JSON.stringify(created.data)).toBe(200);
    const generation = asRecord(created.data.group)!.generation;

    const oldRead = await readGroup(f, groupId, false);
    const oldPolicy = asRecord(oldRead.policy)!;
    expect(oldPolicy).toMatchObject({ strategy: 'manual', autoSwitch: false });
    expect(oldPolicy).not.toHaveProperty('softmaxTemperature');
    expect(oldPolicy).not.toHaveProperty('softmaxOffsetPercent');
    const oldList = await serverRequest(f, 'GET', groupsPath(CLAUDE_SUBSCRIPTION_SERVICE_ID, undefined, false));
    const listed = (oldList.data.groups as unknown[]).map(asRecord).find((group) => group?.groupId === groupId);
    expect(asRecord(listed?.policy)).toMatchObject({ strategy: 'manual', autoSwitch: false });
    expect(asRecord((await readGroup(f, groupId)).policy)).toMatchObject(policy);

    const oldPatch = await serverRequest(f, 'PATCH', groupsPath(CLAUDE_SUBSCRIPTION_SERVICE_ID, groupId, false), {
      expectedGeneration: generation, policy: { ...oldPolicy, cooldownMs: 1234 },
    });
    expect(oldPatch.status).toBe(409);
    expect(oldPatch.data).toEqual({ error: 'connect_group_policy_requires_capability' });
    const unchanged = await readGroup(f, groupId);
    expect(asRecord(unchanged.policy)).toMatchObject(policy);
    expect(unchanged.generation).toBe(generation);
  }, 60_000);
});
