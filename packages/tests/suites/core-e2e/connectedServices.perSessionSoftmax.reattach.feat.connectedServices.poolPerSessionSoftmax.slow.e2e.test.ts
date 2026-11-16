// Per-session softmax adoption across a daemon crash (spec happier-selection-b6573fb3 revision 5,
// A.5 C4, T5/T19; review R16-CUSTODY-01/WRAPPER-02). A session is spawned onto its member and the
// daemon is SIGKILLed before the provider has attested the account; the runner survives. A new
// daemon reattaches it from its marker and reloads launch custody from the durable ledger. The
// original runner's own report must then adopt its decision without a redraw or respawn, while a
// report naming any other process must not.
//
// The session's fake Claude attests nothing; the reports are posted by the test exactly as a runner
// posts them (the composed route under test is the daemon's, not the runner's).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  CLAUDE_CODE_E2E_OAUTH_SCOPE,
  CLAUDE_SUBSCRIPTION_SERVICE_ID,
  asRecord,
  createConnectedServiceProfile,
  spawnConnectedClaudeSession,
  startConnectedServiceRecoveryTokenServer,
  type ConnectedServiceRecoveryTokenServer,
} from '../../src/testkit/connectedServicesRecovery';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { decryptLegacyBase64Normalized } from '../../src/testkit/decryptLegacyBase64Normalized';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { fetchJson } from '../../src/testkit/http';
import { startPerSessionRecoveryFixture, type PerSessionRecoveryFixture } from '../../src/testkit/perSessionSoftmaxRecovery';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';
import { enqueueEncryptedUiTextMessage } from '../../src/testkit/uiMessages';

type UnknownRecord = Record<string, unknown>;

const run = createRunDirs({ runLabel: 'core' });
const cliSnapshotDir = process.env.HAPPIER_E2E_PER_SESSION_CLI_SNAPSHOT_DIR?.trim() || undefined;
const SOFTMAX_FEATURE_ENV = { HAPPIER_FEATURE_CONNECTED_SERVICES_POOL_PER_SESSION_SOFTMAX__ENABLED: '1' };
const MEMBERS = ['alpha', 'beta'] as const;
const organizationOf = (profileId: string) => `org-${profileId}`;

// Agent SDK runner (the daemon tracks the runner itself) and unified-terminal runner (launched through
// the terminal host, so a reattached tracker may name a different process than launch custody).
describe.each([
  { label: 'agent SDK runner', claudeUnifiedTerminalEnabled: false },
  { label: 'unified-terminal runner', claudeUnifiedTerminalEnabled: true },
] as const)('core e2e: per-session adoption across a daemon crash ($label)', ({ label, claudeUnifiedTerminalEnabled }) => {
  let fixture: PerSessionRecoveryFixture | null = null;
  let tokenServer: ConnectedServiceRecoveryTokenServer | null = null;
  const silentClaudeEnv = {
    HAPPIER_E2E_FAKE_CLAUDE_ALLOW_ACCESS_ONLY_NATIVE_OAUTH: '1',
    HAPPIER_E2E_FAKE_CLAUDE_CREDENTIAL_ORG_BY_ACCESS_TOKEN: '{}',
    HAPPIER_LOG_LEVEL: 'debug',
  };
  const fx = () => {
    if (!fixture) throw new Error('fixture not started');
    return fixture;
  };

  beforeAll(async () => {
    const testDir = run.testDir(`per-session-reattach-${claudeUnifiedTerminalEnabled ? 'terminal' : 'sdk'}`);
    tokenServer = await startConnectedServiceRecoveryTokenServer({ respond: () => ({ status: 400, body: { error: 'invalid_grant' } }) });
    fixture = await startPerSessionRecoveryFixture({
      testDir, testName: 'per-session-reattach', tokenUrl: tokenServer.tokenUrl,
      fakeClaudePath: fakeClaudeFixturePath(), fakeClaudeLogPath: resolve(testDir, 'fake-claude.jsonl'),
      accountSettings: { claudeUnifiedTerminalEnabled },
      serverExtraEnv: SOFTMAX_FEATURE_ENV, extraEnv: { ...SOFTMAX_FEATURE_ENV, ...silentClaudeEnv },
      ...(cliSnapshotDir ? { cliSnapshotDir } : {}),
    });
    for (const profileId of MEMBERS) {
      await createConnectedServiceProfile({
        fixture, serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID, profileId, providerEmail: `${profileId}@example.test`, idToken: null,
        accessToken: `access-${profileId}`, refreshToken: `refresh-${profileId}`, scope: CLAUDE_CODE_E2E_OAUTH_SCOPE,
        tokenType: 'Bearer', providerAccountId: `acct-${profileId}`, expiresAt: Date.now() + 3600_000,
        oauthRaw: { claudeAiOauth: { organizationUuid: organizationOf(profileId), subscriptionType: 'max' } },
      });
    }
  }, 300_000);

  afterAll(async () => {
    await fixture?.teardown().catch(() => {});
    await tokenServer?.stop().catch(() => {});
  }, 120_000);

  const readMetadata = async (sessionId: string): Promise<UnknownRecord | null> => {
    const f = fx();
    const session = await fetchSessionV2(f.serverBaseUrl, f.auth.token, sessionId);
    return asRecord(decryptLegacyBase64Normalized(session.metadata, f.accountSecret));
  };
  const readBinding = async (sessionId: string) =>
    asRecord(asRecord(asRecord((await readMetadata(sessionId))?.connectedServices)?.bindingsByServiceId)?.[CLAUDE_SUBSCRIPTION_SERVICE_ID]);
  const readLedgerEntry = async (decisionId: string): Promise<UnknownRecord | null> => {
    const f = fx();
    const path = resolve(f.daemonHomeDir, 'servers', f.serverId, 'connected-services', 'per-session-assignments.json');
    const snapshot = asRecord(JSON.parse(await readFile(path, 'utf8')) as unknown);
    return asRecord(asRecord(snapshot?.entriesByDecisionId)?.[decisionId]);
  };
  const runnerPidOf = async (sessionId: string): Promise<number | null> => {
    const f = fx();
    const listed = await daemonControlPostJson<{ children?: Array<{ happySessionId?: string; pid?: number }> }>({
      port: f.daemonPort, path: '/list', controlToken: f.controlToken, body: {},
    });
    return listed.data.children?.find((child) => child.happySessionId === sessionId)?.pid ?? null;
  };

  it('the reattached original runner adopts its launched decision; another process cannot', async () => {
    const f = fx();
    const groupId = `reattach-${claudeUnifiedTerminalEnabled ? 'terminal' : 'sdk'}`;
    void label;
    const created = await fetchJson<UnknownRecord>(`${f.serverBaseUrl}/v3/connect/${CLAUDE_SUBSCRIPTION_SERVICE_ID}/groups?happierPoolPerSessionSoftmax=1`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${f.auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupId, members: MEMBERS.map((profileId, index) => ({ profileId, priority: (index + 1) * 10 })),
        activeProfileId: 'beta', policy: { strategy: 'per_session_softmax', autoSwitch: true, recoveryMode: 'switch_or_wait' },
      }),
      timeoutMs: 20_000,
    });
    expect(created.status, JSON.stringify(created.data)).toBe(200);

    const sessionId = await spawnConnectedClaudeSession({
      fixture: f, sessionId: randomUUID(), groupId, initialProfileId: 'alpha', extraEnvironmentVariables: silentClaudeEnv,
    });
    let decisionId = '';
    await waitFor(async () => {
      decisionId = String(asRecord((await readBinding(sessionId))?.materializedAssignment)?.decisionId ?? '');
      return decisionId.length > 0;
    }, { timeoutMs: 30_000, context: 'pending target committed' });
    await enqueueEncryptedUiTextMessage({
      baseUrl: f.serverBaseUrl, token: f.auth.token, secret: f.accountSecret, sessionId, text: `PER_SESSION_REATTACH_${randomUUID()}`,
    });
    let nativeSessionId = '';
    await waitFor(async () => {
      nativeSessionId = String((await readMetadata(sessionId))?.claudeSessionId ?? '');
      return nativeSessionId.length > 0;
    }, { timeoutMs: 60_000, context: 'native Claude session recorded' });
    const runnerPid = await runnerPidOf(sessionId);
    expect(runnerPid).toBeTypeOf('number');
    const ledgerBefore = await readLedgerEntry(decisionId);
    expect(ledgerBefore).toMatchObject({ state: 'pending', launchedRunner: { pid: runnerPid } });

    // Crash before adoption; the runner survives and a new daemon reattaches it.
    await f.crashDaemon();
    expect(() => process.kill(runnerPid!, 0)).not.toThrow();
    await f.restartDaemon();
    // The new daemon tracks the session again: the same process, or (wrapped launch) the reporter
    // child its marker names, whose parent is the launch custody's process.
    let reattachedPid: number | null = null;
    await waitFor(async () => {
      reattachedPid = await runnerPidOf(sessionId);
      return reattachedPid !== null;
    }, { timeoutMs: 60_000, context: 'original runner reattached' });
    expect(() => process.kill(runnerPid!, 0)).not.toThrow();
    console.log(`[reattach ${label}] launch pid ${runnerPid}, reattached tracker pid ${reattachedPid}`);
    // The surviving runner re-announces itself to the new daemon on its next activity (its webhook
    // carries the native session id that reports are checked against).
    const restartedDaemonLogMentions = async (needle: string) => {
      const logsDir = resolve(f.daemonHomeDir, 'logs');
      const names = (await readdir(logsDir)).filter((name) => name.endsWith('-daemon.log')).sort();
      const latest = names.at(-1);
      return latest ? (await readFile(resolve(logsDir, latest), 'utf8')).includes(needle) : false;
    };
    await enqueueEncryptedUiTextMessage({
      baseUrl: f.serverBaseUrl, token: f.auth.token, secret: f.accountSecret, sessionId, text: `PER_SESSION_REATTACH_after_${randomUUID()}`,
    });
    await waitFor(async () => await restartedDaemonLogMentions(`Session webhook: ${sessionId}`),
      { timeoutMs: 60_000, context: 'reattached runner re-announced to the new daemon' });

    const report = async (pid: number) => {
      const response = await daemonControlPostJson<UnknownRecord>({
        port: f.daemonPort, path: '/connected-service-turn-lifecycle', controlToken: f.controlToken,
        body: {
          sessionId, event: 'provider_identity_observed',
          providerIdentity: {
            serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID, groupId, providerOrganizationId: organizationOf('alpha'),
            observedAtMs: Date.now(), sourceSessionId: nativeSessionId, runnerPid: pid, launchHome: 'member',
          },
        },
        timeoutMs: 30_000,
      });
      expect(response.status, JSON.stringify(response.data)).toBe(200);
    };

    // Another process (not the session's runner) never adopts.
    await report(reattachedPid! + 1_000_000);
    expect(await readBinding(sessionId)).not.toHaveProperty('member');

    // The reattached original runner adopts the decision it was launched with: no redraw, no respawn.
    await report(reattachedPid!);
    await waitFor(async () => {
      const member = asRecord((await readBinding(sessionId))?.member);
      return member?.decisionId === decisionId && (await readLedgerEntry(decisionId))?.state === 'applied';
    }, { timeoutMs: 30_000, context: 'reattached runner adopts its launched decision' });
    expect(asRecord((await readBinding(sessionId))?.member)).toMatchObject({ profileId: 'alpha', decisionId });
    expect(await runnerPidOf(sessionId)).toBe(reattachedPid);
  }, 300_000);
});
