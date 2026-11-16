// Helpers for the per-session softmax lifecycle acceptance suite (spec happier-selection-b6573fb3
// revision 5, Appendix C.2, T2 remainder, T6–T13, T15). They drive only public entry points: the
// server-light HTTP routes, the daemon control server, server session metadata, the daemon's own
// durable files, and the fake Claude's log. Nothing here calls production code in-process.

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readlink, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  CLAUDE_SUBSCRIPTION_SERVICE_ID,
  asRecord,
  type StartedConnectedServicesClaudeDaemonFixture,
} from './connectedServicesRecovery';
import { daemonControlPostJson } from './daemon/controlServerClient';
import { decryptLegacyBase64Normalized } from './decryptLegacyBase64Normalized';
import { readFakeClaudeLogEvents } from './fakeClaude';
import { fetchJson } from './http';
import { fetchSessionV2 } from './sessions';

export type UnknownRecord = Record<string, unknown>;
type Fixture = StartedConnectedServicesClaudeDaemonFixture;

export const SOFTMAX_FEATURE_ENV = { HAPPIER_FEATURE_CONNECTED_SERVICES_POOL_PER_SESSION_SOFTMAX__ENABLED: '1' };
export const CAPABILITY_QUERY = 'happierPoolPerSessionSoftmax=1';

export const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

export async function serverRequest(
  fixture: Fixture,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
    timeoutMs: 20_000,
  });
  return { status: response.status, data: asRecord(response.data) ?? {} };
}

export function groupsPath(groupId?: string, suffix = '', withCapability = true): string {
  const base = `/v3/connect/${CLAUDE_SUBSCRIPTION_SERVICE_ID}/groups${groupId ? `/${groupId}` : ''}${suffix}`;
  return withCapability ? `${base}${base.includes('?') ? '&' : '?'}${CAPABILITY_QUERY}` : base;
}

export async function createGroup(fixture: Fixture, params: Readonly<{
  groupId: string;
  members: ReadonlyArray<Readonly<{ profileId: string; enabled?: boolean }>>;
  activeProfileId?: string;
  policy: UnknownRecord;
}>): Promise<UnknownRecord> {
  const response = await serverRequest(fixture, 'POST', groupsPath(), {
    groupId: params.groupId,
    members: params.members.map((member, index) => ({ ...member, priority: (index + 1) * 10 })),
    ...(params.activeProfileId ? { activeProfileId: params.activeProfileId } : {}),
    policy: params.policy,
  });
  const group = asRecord(response.data.group);
  if (response.status !== 200 || !group) throw new Error(`create group ${params.groupId}: ${response.status} ${JSON.stringify(response.data)}`);
  return group;
}

export async function readGroup(fixture: Fixture, groupId: string, withCapability = true): Promise<UnknownRecord> {
  const response = await serverRequest(fixture, 'GET', groupsPath(groupId, '', withCapability));
  const group = asRecord(response.data.group);
  if (response.status !== 200 || !group) throw new Error(`GET group ${groupId}: ${response.status} ${JSON.stringify(response.data)}`);
  return group;
}

export async function patchGroup(fixture: Fixture, groupId: string, body: UnknownRecord): Promise<{ status: number; data: UnknownRecord }> {
  const group = await readGroup(fixture, groupId);
  return await serverRequest(fixture, 'PATCH', groupsPath(groupId), { expectedGeneration: group.generation, ...body });
}

export async function patchMember(
  fixture: Fixture,
  groupId: string,
  profileId: string,
  body: UnknownRecord,
): Promise<{ status: number; data: UnknownRecord }> {
  const group = await readGroup(fixture, groupId);
  return await serverRequest(fixture, 'PATCH', groupsPath(groupId, `/members/${profileId}`), {
    expectedGeneration: group.generation, ...body,
  });
}

export async function deleteMember(fixture: Fixture, groupId: string, profileId: string): Promise<{ status: number; data: UnknownRecord }> {
  const group = await readGroup(fixture, groupId);
  return await serverRequest(fixture, 'DELETE',
    `/v3/connect/${CLAUDE_SUBSCRIPTION_SERVICE_ID}/groups/${groupId}/members/${profileId}?expectedGeneration=${String(group.generation)}&${CAPABILITY_QUERY}`);
}

export async function postActiveProfile(fixture: Fixture, groupId: string, profileId: string): Promise<{ status: number; data: UnknownRecord }> {
  const group = await readGroup(fixture, groupId);
  return await serverRequest(fixture, 'POST', groupsPath(groupId, '/active-profile'), {
    expectedGeneration: group.generation, profileId,
  });
}

/** Writes member runtime state through the generation- and revision-fenced runtime-state route. */
export async function patchMemberRuntimeStates(
  fixture: Fixture,
  groupId: string,
  memberStates: ReadonlyArray<Readonly<{ profileId: string; state: UnknownRecord }>>,
): Promise<UnknownRecord> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const group = await readGroup(fixture, groupId);
    const response = await serverRequest(fixture, 'PATCH', groupsPath(groupId, '/runtime-state'), {
      expectedGeneration: group.generation,
      expectedRuntimeStateRevision: group.runtimeStateRevision,
      memberStates,
    });
    if (response.status === 200) return asRecord(response.data.group) ?? {};
    if (response.status !== 409) throw new Error(`runtime-state PATCH ${groupId}: ${response.status} ${JSON.stringify(response.data)}`);
  }
  throw new Error(`runtime-state PATCH ${groupId}: kept conflicting`);
}

export type ReservationRow = Readonly<{ decisionId: string; profileId: string; sessionId: string; state: string; ownerMachineId: string }>;

export async function readReservations(fixture: Fixture, groupId: string): Promise<{ reservationRevision: number; reservations: ReservationRow[] }> {
  const response = await serverRequest(fixture, 'GET', `/v3/connect/${CLAUDE_SUBSCRIPTION_SERVICE_ID}/groups/${groupId}/assignment-reservations`);
  if (response.status !== 200) throw new Error(`GET reservations: ${response.status} ${JSON.stringify(response.data)}`);
  return {
    reservationRevision: Number(response.data.reservationRevision),
    reservations: (Array.isArray(response.data.reservations) ? response.data.reservations : []) as ReservationRow[],
  };
}

export async function readSessionMetadata(fixture: Fixture, sessionId: string): Promise<UnknownRecord | null> {
  const session = await fetchSessionV2(fixture.serverBaseUrl, fixture.auth.token, sessionId);
  return asRecord(decryptLegacyBase64Normalized(session.metadata, fixture.accountSecret));
}

/** The session's committed claude-subscription binding (server session metadata). */
export async function readSessionBinding(fixture: Fixture, sessionId: string): Promise<UnknownRecord | null> {
  const metadata = await readSessionMetadata(fixture, sessionId);
  const bindings = asRecord(asRecord(metadata?.connectedServices)?.bindingsByServiceId);
  return asRecord(bindings?.[CLAUDE_SUBSCRIPTION_SERVICE_ID]);
}

export function ledgerPath(fixture: Fixture): string {
  return resolve(fixture.daemonHomeDir, 'servers', fixture.serverId, 'connected-services', 'per-session-assignments.json');
}

export async function readLedger(fixture: Fixture): Promise<Record<string, UnknownRecord>> {
  try {
    const snapshot = asRecord(JSON.parse(await readFile(ledgerPath(fixture), 'utf8')) as unknown);
    return (asRecord(snapshot?.entriesByDecisionId) ?? {}) as Record<string, UnknownRecord>;
  } catch {
    return {};
  }
}

export type DaemonChild = Readonly<{ happySessionId?: string; pid?: number; [key: string]: unknown }>;

export async function listDaemonChildren(fixture: Fixture): Promise<DaemonChild[]> {
  const listed = await daemonControlPostJson<{ children?: DaemonChild[] }>({
    port: fixture.daemonPort, path: '/list', controlToken: fixture.controlToken, body: {},
  });
  return listed.data.children ?? [];
}

export async function runnerPidOf(fixture: Fixture, sessionId: string): Promise<number | null> {
  const child = (await listDaemonChildren(fixture)).find((entry) => entry.happySessionId === sessionId);
  return typeof child?.pid === 'number' ? child.pid : null;
}

export async function stopSession(fixture: Fixture, sessionId: string): Promise<void> {
  await daemonControlPostJson({
    port: fixture.daemonPort, path: '/stop-session', controlToken: fixture.controlToken, body: { sessionId }, timeoutMs: 30_000,
  }).catch(() => {});
}

export type SpawnRequest = Readonly<{
  sessionId?: string;
  existingSessionId?: string;
  groupId?: string;
  initialProfileId?: string;
  modelId?: string;
  /** Extra binding fields (used to forge daemon-owned assignment state). */
  bindingExtras?: UnknownRecord;
  /** Replaces the whole connectedServices envelope when given. */
  connectedServices?: unknown;
  environmentVariables?: Readonly<Record<string, string>>;
}>;

export type SpawnResponse = Readonly<{ status: number; data: { success?: boolean; sessionId?: unknown; error?: string; errorCode?: string } }>;

/** POSTs a daemon `/spawn-session` for a Claude group binding (optionally with a model). */
export async function requestSpawn(fixture: Fixture, request: SpawnRequest): Promise<SpawnResponse> {
  return await daemonControlPostJson<SpawnResponse['data']>({
    port: fixture.daemonPort,
    path: '/spawn-session',
    controlToken: fixture.controlToken,
    body: {
      directory: fixture.workspaceDir,
      agent: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(request.existingSessionId ? { existingSessionId: request.existingSessionId } : {}),
      ...(request.modelId ? { modelId: request.modelId } : {}),
      terminal: { mode: 'plain' },
      environmentVariables: {
        CI: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_HOME_DIR: fixture.daemonHomeDir,
        HAPPIER_SERVER_URL: fixture.serverBaseUrl,
        HAPPIER_WEBAPP_URL: fixture.serverBaseUrl,
        HAPPIER_E2E_FAKE_CLAUDE_LOG: fixture.fakeClaudeLogPath,
        HAPPIER_E2E_FAKE_CLAUDE_REQUIRE_NATIVE_OAUTH: '1',
        ...(request.environmentVariables ?? {}),
      },
      connectedServices: request.connectedServices ?? {
        v: 1,
        bindingsByServiceId: {
          [CLAUDE_SUBSCRIPTION_SERVICE_ID]: {
            source: 'connected',
            ...(request.groupId ? { selection: 'group', groupId: request.groupId } : {}),
            ...(request.initialProfileId ? { initialProfileId: request.initialProfileId } : {}),
            ...(request.bindingExtras ?? {}),
          },
        },
      },
    },
    timeoutMs: 90_000,
  });
}

export async function spawnOk(fixture: Fixture, request: SpawnRequest): Promise<string> {
  const response = await requestSpawn(fixture, request);
  if (response.status !== 200 || response.data.success !== true || typeof response.data.sessionId !== 'string') {
    throw new Error(`spawn failed: ${response.status} ${JSON.stringify(response.data)}`);
  }
  return response.data.sessionId;
}

/** Fake Claude events with the given type, optionally restricted to one native session ID. */
export async function fakeClaudeEvents(fixture: Fixture, type: string): Promise<UnknownRecord[]> {
  return ((await readFakeClaudeLogEvents(fixture.fakeClaudeLogPath)) as UnknownRecord[]).filter((event) => event.type === type);
}

/** Emitted credential_org attestations whose native session ID belongs to the given set. */
export async function attestationsForNativeSession(fixture: Fixture, nativeSessionId: string): Promise<UnknownRecord[]> {
  return (await fakeClaudeEvents(fixture, 'credential_org_attachment'))
    .filter((event) => event.emitted === true && event.sessionId === nativeSessionId);
}

/** Fake Claude invocations (provider processes) with the given CLAUDE_CONFIG_DIR prefix or `--resume` id. */
export function argValue(argv: unknown, flag: string): string | null {
  if (!Array.isArray(argv)) return null;
  const index = argv.indexOf(flag);
  return index >= 0 && typeof argv[index + 1] === 'string' ? String(argv[index + 1]) : null;
}

/** The member profile home a Claude config dir belongs to, e.g. `.../homes/claude-subscription/<profile>/...`. */
export function memberHomeProfileOf(claudeConfigDir: string): string | null {
  const match = new RegExp(`/homes/${CLAUDE_SUBSCRIPTION_SERVICE_ID}/([^/]+)/`).exec(claudeConfigDir);
  return match && match[1] !== '__groups' ? match[1]! : null;
}

export function isGroupHome(claudeConfigDir: string, groupId: string): boolean {
  return claudeConfigDir.includes(`/homes/${CLAUDE_SUBSCRIPTION_SERVICE_ID}/__groups/${groupId}/`);
}

export function groupHomeRoot(fixture: Fixture, groupId: string): string {
  return resolve(fixture.daemonHomeDir, 'servers', fixture.serverId, 'daemon', 'connected-services', 'homes',
    CLAUDE_SUBSCRIPTION_SERVICE_ID, '__groups', groupId);
}

/** sha256 of every regular file under a directory, keyed by relative path (symlinks recorded as links). */
export async function snapshotTree(root: string): Promise<Record<string, string>> {
  const { readdir } = await import('node:fs/promises');
  const out: Record<string, string> = {};
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = resolve(dir, entry.name);
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        out[key] = `link:${await readlink(path).catch(() => '?')}`;
      } else if (entry.isDirectory()) {
        if (entry.name === 'projects') { out[key] = 'dir'; continue; }
        await walk(path, key);
      } else if (entry.isFile()) {
        out[key] = createHash('sha256').update(await readFile(path)).digest('hex');
      }
    }
  };
  await walk(root, '');
  return out;
}

/** Follows the `projects` link chain from a Claude config dir; returns each hop and the final real path. */
export async function traceProjectsLink(claudeConfigDir: string): Promise<{ hops: string[]; real: string | null; isLink: boolean }> {
  const hops: string[] = [];
  let current = resolve(claudeConfigDir, 'projects');
  let isLink = false;
  for (let index = 0; index < 10; index += 1) {
    const stat = await lstat(current).catch(() => null);
    if (!stat) return { hops, real: null, isLink };
    hops.push(current);
    if (!stat.isSymbolicLink()) break;
    isLink = true;
    const target = await readlink(current);
    current = resolve(dirname(current), target);
  }
  return { hops, real: await realpath(resolve(claudeConfigDir, 'projects')).catch(() => null), isLink };
}

export function memberHoldsPath(fixture: Fixture): string {
  return resolve(fixture.daemonHomeDir, 'servers', fixture.serverId, 'connected-service-member-holds.json');
}

export type MemberHold = Readonly<{ profileId: string; reason: string; untilMs?: number }>;

/** Replaces the daemon's member-hold file (the store `happier connect hold` writes). */
export async function writeMemberHolds(fixture: Fixture, holds: ReadonlyArray<MemberHold>): Promise<void> {
  const path = memberHoldsPath(fixture);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({
    v: 1,
    holds: holds.map((hold) => ({
      serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID,
      profileId: hold.profileId,
      reason: hold.reason,
      source: 'e2e-lifecycle',
      heldAtMs: Date.now(),
      lifetime: hold.untilMs ? { kind: 'until', untilMs: hold.untilMs } : { kind: 'until_released' },
    })),
  }, null, 2)}\n`, 'utf8');
}

export async function reportFailure(fixture: Fixture, params: Readonly<{
  sessionId: string;
  groupId: string;
  profileId: string;
  kind?: 'usage_limit' | 'auth_expired' | 'rate_limit';
  retryAfterMs?: number | null;
}>): Promise<{ status: number; data: UnknownRecord }> {
  const kind = params.kind ?? 'usage_limit';
  const classification = kind === 'usage_limit'
    ? {
        kind, limitCategory: 'quota', serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID, profileId: params.profileId, groupId: params.groupId,
        resetsAtMs: Date.now() + 3_600_000, retryAfterMs: params.retryAfterMs ?? 3_600_000, quotaScope: 'account',
        providerLimitId: 'weekly', action: null, planType: null, rateLimits: null, source: 'structured_provider_error',
      }
    : kind === 'auth_expired'
      ? {
          kind, limitCategory: 'auth', serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID, profileId: params.profileId, groupId: params.groupId,
          resetsAtMs: null, retryAfterMs: null, quotaScope: 'account', providerLimitId: null, action: null, planType: null,
          rateLimits: null, source: 'stable_provider_message',
        }
      : {
          kind, limitCategory: 'rate_limit', serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID, profileId: params.profileId, groupId: params.groupId,
          resetsAtMs: null, retryAfterMs: null, quotaScope: 'account', providerLimitId: null, action: null, planType: null,
          rateLimits: null, source: 'structured_provider_error',
        };
  const response = await daemonControlPostJson<UnknownRecord>({
    port: fixture.daemonPort,
    path: '/connected-service-runtime-auth/failure',
    controlToken: fixture.controlToken,
    body: { sessionId: params.sessionId, switchesThisTurn: 0, classification },
    timeoutMs: 120_000,
  });
  return { status: response.status, data: asRecord(response.data) ?? {} };
}
