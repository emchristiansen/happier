// Helpers for the per-session softmax math acceptance suite (spec happier-selection-b6573fb3
// revision 5, Appendix C.2 T3, T4, T22, T23).
//
// What is real: server-light routes, two daemons sharing one account and one reservation resource,
// the daemons' quota loop (it fetches every profile's usage from a fixture Claude usage endpoint,
// the provider boundary), the daemons' spawn and runtime-failure entry points, and their durable
// per-session decision ledgers. The fixture usage endpoint is the only place scores are injected.

import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';

import {
  asRecord,
  resolvePreparedCliSnapshotEntrypoint,
  type StartedConnectedServicesClaudeDaemonFixture,
} from './connectedServicesRecovery';
import { seedCliAuthForServer } from './cliAuth';
import { daemonControlPostJson } from './daemon/controlServerClient';
import { startTestDaemon } from './daemon/daemon';
import { createTempPathBin } from './fs/tempPathBin';
import { fetchJson } from './http';
import { repoRootDir } from './paths';
import { decryptLegacyBase64Normalized } from './decryptLegacyBase64Normalized';
import { fetchSessionV2 } from './sessions';

type UnknownRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// Expected values
// ---------------------------------------------------------------------------------------------

/** Full-precision simulation output (theseus revision-3/calc/results.json). */
export const MATH_RESULTS_JSON_PATH = process.env.HAPPIER_E2E_PER_SESSION_MATH_RESULTS_JSON?.trim()
  || '/home/eric/.local/state/theseus-operator/records/deliveries/happier-selection-b6573fb3/revision-3/calc/results.json';
export const MATH_RESULTS_JSON_SHA256 = '09d4dbf281d4390be4e3a146be00058631285987dd0ab3dcacb5add08714e84f';
/** Repository copy of the same vectors (records the results.json sha256 above). */
const REPO_SCENARIO_FIXTURE_PATH = resolve(repoRootDir(), 'apps/cli/src/daemon/connectedServices/accountGroups/selection/__fixtures__/perSessionOffsetOddsScenarios.json');
export const PROPOSED_POLICY_NAME = 'odds tau1.5 delta0.10 (proposed)';

export type MathScenario = Readonly<{ id: string; scores: number[]; fresh: number[]; probabilities: number[] }>;

export type MathReference = Readonly<{
  source: string;
  scenarios: MathScenario[];
  /** boundary.by_delta["0.1"].F1_fresh_probability, keyed by fraction free ("0.9", "0.99", ...). */
  f1BoundaryFreshProbability: Readonly<Record<string, number>>;
  /** bursts.F1[proposed]["8"].shared_count_exact_fresh.mean (exact DP, no release). */
  f1BurstFreshMean: number;
  /** Per-trial standard deviation of the F1 8-burst fresh count (MC se × √trials). */
  f1BurstFreshSd: number;
  /** bursts.S6[proposed]["8"].shared_count_mc.fresh_total_mean.mean (A15 = the 95% account). */
  s6BurstA15Mean: number;
  s6BurstA15Sd: number;
}>;

// Burst constants as printed by results.json (used only when results.json is unavailable; the
// loader cross-checks them against results.json whenever it is present).
const F1_BURST_FRESH_MEAN = 1.1994442970783785;
const F1_BURST_FRESH_SD = 0.0030594696424768343 * Math.sqrt(40_000);
const S6_BURST_A15_MEAN = 1.495275;
const S6_BURST_A15_SD = 0.0035598116053861114 * Math.sqrt(40_000);

export function loadMathReference(): MathReference {
  if (existsSync(MATH_RESULTS_JSON_PATH)) {
    const raw = readFileSync(MATH_RESULTS_JSON_PATH);
    const sha = createHash('sha256').update(raw).digest('hex');
    if (sha !== MATH_RESULTS_JSON_SHA256) throw new Error(`results.json sha256 ${sha} != ${MATH_RESULTS_JSON_SHA256}`);
    const parsed = JSON.parse(raw.toString('utf8')) as UnknownRecord;
    const scenarios = Object.entries(asRecord(parsed.scenarios)!).map(([id, value]) => {
      const scenario = asRecord(value)!;
      const policy = asRecord(asRecord(scenario.policies)![PROPOSED_POLICY_NAME])!;
      return { id, scores: scenario.scores as number[], fresh: scenario.fresh as number[], probabilities: policy.p as number[] };
    });
    const boundary = asRecord(asRecord(asRecord(asRecord(parsed.boundary)!.by_delta)!['0.1'])!.F1_fresh_probability)! as Record<string, number>;
    const f1Burst = asRecord(asRecord(asRecord(asRecord(parsed.bursts)!.F1)![PROPOSED_POLICY_NAME])!['8'])!;
    const s6Burst = asRecord(asRecord(asRecord(asRecord(parsed.bursts)!.S6)![PROPOSED_POLICY_NAME])!['8'])!;
    const f1Mc = asRecord(asRecord(f1Burst.shared_count_mc)!.fresh_total_mean)!;
    const s6Mc = asRecord(asRecord(s6Burst.shared_count_mc)!.fresh_total_mean)!;
    const reference: MathReference = {
      source: `${MATH_RESULTS_JSON_PATH} (sha256 ${sha})`,
      scenarios,
      f1BoundaryFreshProbability: boundary,
      f1BurstFreshMean: Number(asRecord(f1Burst.shared_count_exact_fresh)!.mean),
      f1BurstFreshSd: Number(f1Mc.se) * Math.sqrt(Number(asRecord(f1Burst.shared_count_mc)!.trials)),
      s6BurstA15Mean: Number(s6Mc.mean),
      s6BurstA15Sd: Number(s6Mc.se) * Math.sqrt(Number(asRecord(s6Burst.shared_count_mc)!.trials)),
    };
    if (Math.abs(reference.f1BurstFreshMean - F1_BURST_FRESH_MEAN) > 1e-12 || Math.abs(reference.s6BurstA15Mean - S6_BURST_A15_MEAN) > 1e-12) {
      throw new Error('results.json burst constants disagree with the values this testkit records');
    }
    return reference;
  }
  const fixture = JSON.parse(readFileSync(REPO_SCENARIO_FIXTURE_PATH, 'utf8')) as {
    source: string;
    scenarios: Array<{ id: string; scores: number[]; fresh?: number[]; probabilities: number[] }>;
    f1BoundaryFreshProbability: Record<string, number>;
  };
  if (!fixture.source.includes(MATH_RESULTS_JSON_SHA256)) throw new Error(`repository fixture does not record results.json ${MATH_RESULTS_JSON_SHA256}`);
  return {
    source: `${REPO_SCENARIO_FIXTURE_PATH} (copy of results.json ${MATH_RESULTS_JSON_SHA256})`,
    scenarios: fixture.scenarios.map((scenario) => ({
      id: scenario.id, scores: scenario.scores, probabilities: scenario.probabilities,
      fresh: scenario.fresh ?? scenario.scores.flatMap((score, index) => (score >= 100 ? [index] : [])),
    })),
    f1BoundaryFreshProbability: fixture.f1BoundaryFreshProbability,
    f1BurstFreshMean: F1_BURST_FRESH_MEAN,
    f1BurstFreshSd: F1_BURST_FRESH_SD,
    s6BurstA15Mean: S6_BURST_A15_MEAN,
    s6BurstA15Sd: S6_BURST_A15_SD,
  };
}

/**
 * Independent closed-form reference of the spec weight model (A.2): s' = s/(1+k),
 * w = (s' / (100 − s' + δ))^(1/τ), tier = members whose OBSERVED score is above the soft threshold
 * (all scored members when none is), p = w / Σ_tier w. Plain powers, not the production log form.
 */
export function referenceOffsetOddsProbabilities(input: Readonly<{
  scores: ReadonlyArray<number>;
  counts?: ReadonlyArray<number>;
  temperature?: number;
  offsetPercent?: number;
  softSwitchRemainingPercent?: number;
}>): number[] {
  const tau = input.temperature ?? 1.5;
  const delta = input.offsetPercent ?? 10;
  const soft = input.softSwitchRemainingPercent ?? 15;
  const anyAbove = input.scores.some((score) => score > soft);
  const weights = input.scores.map((score, index) => {
    if (anyAbove && !(score > soft)) return 0;
    const adjusted = score / (1 + (input.counts?.[index] ?? 0));
    return (adjusted / (100 - adjusted + delta)) ** (1 / tau);
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
}

// ---------------------------------------------------------------------------------------------
// Provider boundary: Claude OAuth usage endpoint
// ---------------------------------------------------------------------------------------------

export type ClaudeUsageFixtureServer = Readonly<{
  usageUrl: string;
  /** Sets the remaining percentage the endpoint reports for one access token (five-hour window). */
  setRemainingPercent: (accessToken: string, remainingPercent: number) => void;
  /** Access tokens the endpoint has served at least once. */
  servedAccessTokens: () => ReadonlySet<string>;
  /** A usage URL that attributes its requests to `label` (one per daemon). */
  usageUrlFor: (label: string) => string;
  /** Access tokens served to requests made through `usageUrlFor(label)`. */
  servedAccessTokensFor: (label: string) => ReadonlySet<string>;
  requestCount: () => number;
  stop: () => Promise<void>;
}>;

export async function startClaudeUsageFixtureServer(): Promise<ClaudeUsageFixtureServer> {
  const utilizationByAccessToken = new Map<string, number>();
  const served = new Set<string>();
  /** Tokens served per requesting daemon (the label in its usage URL path, `/<label>/api/oauth/usage`). */
  const servedByLabel = new Map<string, Set<string>>();
  let requests = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests += 1;
    const label = /^\/([^/]+)\/api\/oauth\/usage/u.exec(req.url ?? '')?.[1] ?? '';
    const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const accessToken = auth.replace(/^Bearer\s+/iu, '').trim();
    const utilization = utilizationByAccessToken.get(accessToken);
    res.setHeader('content-type', 'application/json');
    if (utilization === undefined) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'unknown_token' }));
      return;
    }
    served.add(accessToken);
    if (!servedByLabel.has(label)) servedByLabel.set(label, new Set());
    servedByLabel.get(label)!.add(accessToken);
    res.statusCode = 200;
    res.end(JSON.stringify({
      five_hour: { utilization, resets_at: new Date(Date.now() + 4 * 60 * 60_000).toISOString() },
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('usage fixture server has no address');
  return {
    usageUrl: `http://127.0.0.1:${address.port}/api/oauth/usage`,
    usageUrlFor: (label) => `http://127.0.0.1:${address.port}/${encodeURIComponent(label)}/api/oauth/usage`,
    servedAccessTokensFor: (label) => new Set(servedByLabel.get(encodeURIComponent(label)) ?? []),
    setRemainingPercent: (accessToken, remainingPercent) => {
      utilizationByAccessToken.set(accessToken, 100 - remainingPercent);
    },
    servedAccessTokens: () => new Set(served),
    requestCount: () => requests,
    stop: async () => {
      server.closeAllConnections?.();
      server.close();
      await once(server, 'close').catch(() => {});
    },
  };
}

/** Daemon environment that makes the quota loop fetch every profile once and keep it fresh for the run. */
export function perSessionMathQuotaEnv(usageUrl: string): Record<string, string> {
  return {
    HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: '1',
    HAPPIER_CONNECTED_SERVICES_QUOTAS_TICK_MS: '2000',
    HAPPIER_CONNECTED_SERVICES_QUOTAS_LOOP_JITTER_MS: '0',
    HAPPIER_CONNECTED_SERVICES_QUOTAS_DISCOVERY_ENABLED: '1',
    HAPPIER_CONNECTED_SERVICES_QUOTAS_DISCOVERY_INTERVAL_MS: '5000',
    HAPPIER_CONNECTED_SERVICES_QUOTAS_FETCH_TIMEOUT_MS: '5000',
    HAPPIER_CONNECTED_SERVICES_QUOTAS_STALE_AFTER_MS: String(2 * 60 * 60_000),
    HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_QUOTA_FRESHNESS_MS: String(2 * 60 * 60_000),
    HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_USAGE_URL: usageUrl,
  };
}

// ---------------------------------------------------------------------------------------------
// A second daemon on the same server/account
// ---------------------------------------------------------------------------------------------

/**
 * Starts another daemon (own home, own machine id) for the account of `primary`, against the same
 * server. Both daemons read and write the same per-group reservation resource.
 */
export async function startAdditionalConnectedServicesClaudeDaemon(params: Readonly<{
  primary: StartedConnectedServicesClaudeDaemonFixture;
  testDir: string;
  label: string;
  tokenUrl: string;
  fakeClaudePath: string;
  extraEnv?: Record<string, string>;
  cliSnapshotDir?: string;
}>): Promise<StartedConnectedServicesClaudeDaemonFixture> {
  const { primary } = params;
  const daemonHomeDir = resolve(join(params.testDir, `daemon-home-${params.label}`));
  const workspaceDir = resolve(join(params.testDir, `workspace-${params.label}`));
  const sourceClaudeConfigDir = resolve(join(params.testDir, `source-claude-config-${params.label}`));
  await mkdir(daemonHomeDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(sourceClaudeConfigDir, { recursive: true });
  await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"e2e"}\n', 'utf8');
  const { serverId, machineId } = await seedCliAuthForServer({
    cliHome: daemonHomeDir, serverUrl: primary.serverBaseUrl, token: primary.auth.token, secret: primary.accountSecret,
  });
  const tempPathBin = await createTempPathBin({ prefix: `happier-claude-math-${params.label}-bin-`, baseDir: params.testDir, env: process.env });
  const snapshotEnv: Record<string, string> = params.cliSnapshotDir ? {
    HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
    HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: resolvePreparedCliSnapshotEntrypoint(params.cliSnapshotDir),
    HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0',
  } : { HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1' };
  const fakeClaudeLogPath = resolve(join(params.testDir, `fake-claude-${params.label}.jsonl`));
  const env: NodeJS.ProcessEnv = {
    ...tempPathBin.env,
    CI: '1',
    HAPPIER_VARIANT: 'dev',
    HAPPIER_DISABLE_CAFFEINATE: '1',
    HAPPIER_HOME_DIR: daemonHomeDir,
    HAPPIER_SERVER_URL: primary.serverBaseUrl,
    HAPPIER_WEBAPP_URL: primary.serverBaseUrl,
    HAPPIER_ACTIVE_SERVER_ID: serverId,
    CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
    HAPPIER_CLAUDE_PATH: params.fakeClaudePath,
    HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
    HAPPIER_E2E_FAKE_CLAUDE_REQUIRE_NATIVE_OAUTH: '1',
    ...snapshotEnv,
    HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '1',
    HAPPIER_CONNECTED_SERVICES_REFRESH_TICK_MS: '300000',
    HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_RESTART_SIGNAL_DELAY_MS: '0',
    HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL: params.tokenUrl,
    HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID: 'happier-e2e-claude-client',
    ...(params.extraEnv ?? {}),
  };
  if (params.cliSnapshotDir) {
    delete env.HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT;
    delete env.HAPPY_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT;
  }
  const daemon = await startTestDaemon({
    testDir: join(params.testDir, params.label),
    happyHomeDir: daemonHomeDir,
    env,
    startupTimeoutMs: 120_000,
    ...(params.cliSnapshotDir ? { snapshotDir: params.cliSnapshotDir, preparedDistSnapshotOnly: true } : {}),
  });
  const startedAt = Date.now();
  for (;;) {
    const listed = await daemonControlPostJson({
      port: daemon.state.httpPort, path: '/list', body: {}, controlToken: daemon.state.controlToken, timeoutMs: 5_000,
    }).catch(() => null);
    if (listed?.status === 200) break;
    if (Date.now() - startedAt > 20_000) throw new Error(`daemon ${params.label} control /list did not come up`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return {
    server: primary.server,
    serverBaseUrl: primary.serverBaseUrl,
    auth: primary.auth,
    accountSecret: primary.accountSecret,
    daemon,
    daemonHomeDir,
    workspaceDir,
    serverId,
    machineId,
    daemonPort: daemon.state.httpPort,
    controlToken: daemon.state.controlToken,
    fakeClaudeLogPath,
    fakeClaudeScenario: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Server routes and daemon records
// ---------------------------------------------------------------------------------------------

export const PER_SESSION_CAPABILITY_QUERY = 'happierPoolPerSessionSoftmax=1';

export async function mathServerRequest(
  fixture: Pick<StartedConnectedServicesClaudeDaemonFixture, 'serverBaseUrl' | 'auth'>,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<{ status: number; data: UnknownRecord }> {
  const response = await fetchJson<UnknownRecord>(`${fixture.serverBaseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${fixture.auth.token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    timeoutMs: 30_000,
  });
  return { status: response.status, data: asRecord(response.data) ?? {} };
}

export async function createPerSessionGroup(
  fixture: Pick<StartedConnectedServicesClaudeDaemonFixture, 'serverBaseUrl' | 'auth'>,
  params: Readonly<{ groupId: string; memberProfileIds: ReadonlyArray<string>; activeProfileId: string; policy?: UnknownRecord }>,
): Promise<UnknownRecord> {
  const response = await mathServerRequest(fixture, 'POST', `/v3/connect/claude-subscription/groups?${PER_SESSION_CAPABILITY_QUERY}`, {
    groupId: params.groupId,
    members: params.memberProfileIds.map((profileId, index) => ({ profileId, priority: (index + 1) * 10 })),
    activeProfileId: params.activeProfileId,
    policy: { strategy: 'per_session_softmax', autoSwitch: true, recoveryMode: 'switch_or_wait', ...(params.policy ?? {}) },
  });
  const group = asRecord(response.data.group);
  if (response.status !== 200 || !group) throw new Error(`create group ${params.groupId} failed: ${response.status} ${JSON.stringify(response.data)}`);
  return group;
}

export async function readPerSessionGroup(
  fixture: Pick<StartedConnectedServicesClaudeDaemonFixture, 'serverBaseUrl' | 'auth'>,
  groupId: string,
): Promise<UnknownRecord> {
  const response = await mathServerRequest(fixture, 'GET', `/v3/connect/claude-subscription/groups/${groupId}?${PER_SESSION_CAPABILITY_QUERY}`);
  const group = asRecord(response.data.group);
  if (response.status !== 200 || !group) throw new Error(`GET group ${groupId} failed: ${response.status}`);
  return group;
}

export type MathReservationRow = Readonly<{ decisionId: string; profileId: string; sessionId: string; state: string; ownerMachineId: string; leaseUntilMs: number }>;

export async function readGroupReservations(
  fixture: Pick<StartedConnectedServicesClaudeDaemonFixture, 'serverBaseUrl' | 'auth'>,
  groupId: string,
): Promise<{ reservationRevision: number; reservations: MathReservationRow[] }> {
  const response = await mathServerRequest(fixture, 'GET', `/v3/connect/claude-subscription/groups/${groupId}/assignment-reservations`);
  if (response.status !== 200) throw new Error(`GET reservations ${groupId} failed: ${response.status} ${JSON.stringify(response.data)}`);
  return {
    reservationRevision: Number(response.data.reservationRevision),
    reservations: (Array.isArray(response.data.reservations) ? response.data.reservations : []) as MathReservationRow[],
  };
}

export type MathLedgerEntry = Readonly<{
  decisionId: string;
  sessionId: string;
  groupId: string;
  origin: 'spawn' | 'recovery';
  state: string;
  proposal: Readonly<{
    decisionId: string;
    proposalRevision: number;
    profileId: string;
    reason: string;
    fromProfileId: string | null;
    temperature: number;
    offsetPercent: number;
    probability: number | null;
    custody: string;
    observedReservationRevision: number | null;
  }>;
  /** Which daemon's ledger the entry came from. */
  daemonLabel: string;
}>;

/** All entries of one daemon's durable per-session decision ledger (spec A.3, A.5). */
export async function readDecisionLedger(
  fixture: Pick<StartedConnectedServicesClaudeDaemonFixture, 'daemonHomeDir' | 'serverId'>,
  daemonLabel: string,
): Promise<MathLedgerEntry[]> {
  const path = resolve(fixture.daemonHomeDir, 'servers', fixture.serverId, 'connected-services', 'per-session-assignments.json');
  try {
    const snapshot = asRecord(JSON.parse(await readFile(path, 'utf8')) as unknown);
    return Object.values(asRecord(snapshot?.entriesByDecisionId) ?? {}).map((entry) => ({ ...(entry as MathLedgerEntry), daemonLabel }));
  } catch {
    return [];
  }
}

/** The session's committed claude-subscription binding (server session metadata). */
export async function readClaudeSessionBinding(
  fixture: Pick<StartedConnectedServicesClaudeDaemonFixture, 'serverBaseUrl' | 'auth' | 'accountSecret'>,
  sessionId: string,
): Promise<UnknownRecord | null> {
  const session = await fetchSessionV2(fixture.serverBaseUrl, fixture.auth.token, sessionId);
  const metadata = asRecord(decryptLegacyBase64Normalized(session.metadata, fixture.accountSecret));
  const bindings = asRecord(asRecord(metadata?.connectedServices)?.bindingsByServiceId);
  return asRecord(bindings?.['claude-subscription']);
}

export async function stopDaemonSession(
  fixture: Pick<StartedConnectedServicesClaudeDaemonFixture, 'daemonPort' | 'controlToken'>,
  sessionId: string,
): Promise<void> {
  await daemonControlPostJson({
    port: fixture.daemonPort, path: '/stop-session', controlToken: fixture.controlToken, body: { sessionId }, timeoutMs: 30_000,
  }).catch(() => {});
}

export function randomSuffix(): string {
  return randomBytes(4).toString('hex');
}

// ---------------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------------

export function meanAndSampleSd(values: ReadonlyArray<number>): { mean: number; sd: number } {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.length > 1
    ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
    : 0;
  return { mean, sd: Math.sqrt(variance) };
}
