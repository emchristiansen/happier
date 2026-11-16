import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import {
  CLAUDE_CODE_E2E_OAUTH_SCOPE,
  CLAUDE_SUBSCRIPTION_SERVICE_ID,
  asRecord,
  createConnectedServiceProfile,
  startConnectedServiceRecoveryTokenServer,
  startConnectedServicesClaudeDaemon,
  type ConnectedServiceRecoveryTokenServer,
  type StartedConnectedServicesClaudeDaemonFixture,
} from '../../src/testkit/connectedServicesRecovery';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import {
  SOFTMAX_FEATURE_ENV, createGroup, fakeClaudeEvents, listDaemonChildren, readGroup, readLedger, readReservations,
  readSessionBinding, reportFailure, spawnOk, sha256,
} from '../../src/testkit/perSessionSoftmaxLifecycle';
import { createRunDirs } from '../../src/testkit/runDir';
import { sleep, waitFor } from '../../src/testkit/timing';
import { enqueueEncryptedUiTextMessage } from '../../src/testkit/uiMessages';

const run = createRunDirs({ runLabel: 'core' });
const PROFILES = ['alpha', 'beta', 'gamma'];
const accessTokenOf = (p: string) => `access-${p}`;
const organizationOf = (p: string) => `org-${p}`;

describe('probe', () => {
  let fixture: StartedConnectedServicesClaudeDaemonFixture | null = null;
  let tokenServer: ConnectedServiceRecoveryTokenServer | null = null;
  const fakeClaudeEnv = {
    HAPPIER_E2E_FAKE_CLAUDE_ALLOW_ACCESS_ONLY_NATIVE_OAUTH: '1',
    HAPPIER_E2E_FAKE_CLAUDE_CREDENTIAL_ORG_BY_ACCESS_TOKEN: JSON.stringify(Object.fromEntries(PROFILES.map((p) => [accessTokenOf(p), organizationOf(p)]))),
    HAPPIER_LOG_LEVEL: 'debug',
  };
  beforeAll(async () => {
    const testDir = run.testDir('per-session-lifecycle-probe');
    tokenServer = await startConnectedServiceRecoveryTokenServer({ respond: () => ({ status: 400, body: { error: 'invalid_grant' } }) });
    fixture = await startConnectedServicesClaudeDaemon({
      testDir, testName: 'per-session-lifecycle-probe', tokenUrl: tokenServer.tokenUrl,
      fakeClaudePath: fakeClaudeFixturePath(), fakeClaudeLogPath: resolve(testDir, 'fake-claude.jsonl'),
      accountSettings: { claudeUnifiedTerminalEnabled: false },
      serverExtraEnv: SOFTMAX_FEATURE_ENV, extraEnv: { ...SOFTMAX_FEATURE_ENV, ...fakeClaudeEnv },
    });
    for (const profileId of PROFILES) {
      await createConnectedServiceProfile({
        fixture, serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID, profileId, providerEmail: `${profileId}@example.test`, idToken: null,
        accessToken: accessTokenOf(profileId), refreshToken: `refresh-${profileId}`, scope: CLAUDE_CODE_E2E_OAUTH_SCOPE,
        tokenType: 'Bearer', providerAccountId: `acct-${profileId}`, expiresAt: Date.now() + 3600_000,
        oauthRaw: { claudeAiOauth: { organizationUuid: organizationOf(profileId), subscriptionType: 'max' } },
      });
    }
  }, 300_000);
  afterAll(async () => {
    await fixture?.daemon.stop().catch(() => {});
    await fixture?.server.stop().catch(() => {});
    await tokenServer?.stop().catch(() => {});
  }, 120_000);

  it('probe', async () => {
    const f = fixture!;
    const groupId = 'probe';
    const g = await createGroup(f, { groupId, members: PROFILES.map((profileId) => ({ profileId })), activeProfileId: 'gamma',
      policy: { strategy: 'per_session_softmax', autoSwitch: true, recoveryMode: 'switch_or_wait' } });
    console.log('PROBE group', JSON.stringify(g));
    const s1 = await spawnOk(f, { sessionId: randomUUID(), groupId, initialProfileId: 'alpha', environmentVariables: fakeClaudeEnv });
    const s2 = await spawnOk(f, { sessionId: randomUUID(), groupId, initialProfileId: 'beta', environmentVariables: fakeClaudeEnv });
    for (const s of [s1, s2]) {
      await enqueueEncryptedUiTextMessage({ baseUrl: f.serverBaseUrl, token: f.auth.token, secret: f.accountSecret, sessionId: s, text: `turn-${s}` });
    }
    await waitFor(async () => {
      const b1 = asRecord((await readSessionBinding(f, s1))?.member); const b2 = asRecord((await readSessionBinding(f, s2))?.member);
      return b1?.profileId === 'alpha' && b2?.profileId === 'beta';
    }, { timeoutMs: 60_000, context: 'adopt' });
    console.log('PROBE children', JSON.stringify(await listDaemonChildren(f)));
    console.log('PROBE invocations', JSON.stringify((await fakeClaudeEvents(f, 'invocation')).map((e) => ({ pid: e.pid, dir: e.claudeConfigDir, argv: e.argv }))));
    console.log('PROBE attest', JSON.stringify((await fakeClaudeEvents(f, 'credential_org_attachment')).map((e) => ({ s: e.sessionId, inv: e.invocationId, dir: e.claudeConfigDir, org: e.organizationUuid }))));
    const groupAfter = await readGroup(f, groupId);
    console.log('PROBE groupAfter', JSON.stringify(groupAfter));
    const failure = await reportFailure(f, { sessionId: s1, groupId, profileId: 'alpha' });
    console.log('PROBE failure', JSON.stringify(failure));
    await sleep(15_000);
    await enqueueEncryptedUiTextMessage({ baseUrl: f.serverBaseUrl, token: f.auth.token, secret: f.accountSecret, sessionId: s1, text: `turn2-${s1}` });
    await sleep(15_000);
    console.log('PROBE b1', JSON.stringify(await readSessionBinding(f, s1)));
    console.log('PROBE b2', JSON.stringify(await readSessionBinding(f, s2)));
    console.log('PROBE ledger', JSON.stringify(await readLedger(f)));
    console.log('PROBE res', JSON.stringify(await readReservations(f, groupId)));
    console.log('PROBE children2', JSON.stringify(await listDaemonChildren(f)));
    console.log('PROBE invocations2', JSON.stringify((await fakeClaudeEvents(f, 'invocation')).map((e) => ({ pid: e.pid, dir: e.claudeConfigDir, argv: e.argv }))));
    console.log('PROBE attest2', JSON.stringify((await fakeClaudeEvents(f, 'credential_org_attachment')).map((e) => ({ s: e.sessionId, inv: e.invocationId, dir: e.claudeConfigDir, org: e.organizationUuid }))));
    console.log('PROBE group2', JSON.stringify(await readGroup(f, groupId)));
    console.log('PROBE daemonHome', f.daemonHomeDir, f.serverId, sha256('x').slice(0, 4));
    expect(true).toBe(true);
  }, 300_000);
});
