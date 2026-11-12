import type { Credentials } from '@/persistence';
import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SessionUsageLimitRecoveryV1Schema,
  type SessionStatusResult,
} from '@happier-dev/protocol';
import {
  LEGACY_ACP_SESSION_MODELS_STATE_KEY,
  SESSION_MODELS_STATE_KEY,
  readNewestSessionModelsMetadataStateV1,
} from '@happier-dev/agents';
import type { Metadata } from '@/api/types';
import { resolveModelOverrideFromMetadataSnapshot } from '@/agent/runtime/permission/permissionModeFromMetadata';
import { resolveSessionConfigOptionOverridesFromMetadataSnapshot } from '@/agent/runtime/sessionConfigOptionOverrideSync';
import { summarizeSessionRecord, type SessionSummary } from '@/cli/output/session/sessionSummary';
import { decryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import {
  readLatestAgentStateSummaryViaSocket,
  summarizeAgentState,
  type AgentStateSummary,
} from '@/session/transport/socket/sessionSocketAgentState';

import { resolveSessionTransportContext } from './resolveSessionTransportContext';

export type GetSessionStatusResult =
  | Readonly<{
      ok: true;
      session: SessionSummary;
      agentState: AgentStateSummary | null;
      usageLimitRecovery: SessionStatusResult['usageLimitRecovery'];
      runtimeConfig: SessionStatusResult['runtimeConfig'];
    }>
  | Readonly<{ ok: false; code: 'session_not_found' | 'session_id_ambiguous' | 'session_lookup_timeout' | 'unsupported'; candidates?: string[] }>;

function summarizeSessionAgentState(params: Readonly<{
  sessionTarget: Extract<Awaited<ReturnType<typeof resolveSessionTransportContext>>, { ok: true }>;
}>): AgentStateSummary | null {
  const agentStateCiphertext =
    typeof params.sessionTarget.rawSession.agentState === 'string'
      ? String(params.sessionTarget.rawSession.agentState).trim()
      : '';
  if (!agentStateCiphertext) {
    return null;
  }

  try {
    const decrypted =
      params.sessionTarget.mode === 'plain'
        ? JSON.parse(agentStateCiphertext)
        : decryptSessionPayload({
            ctx: params.sessionTarget.ctx,
            ciphertextBase64: agentStateCiphertext,
          });
    return summarizeAgentState(decrypted);
  } catch {
    return null;
  }
}

function resolveLiveStatusWaitMs(): number {
  const liveWaitRaw = String(process.env.HAPPIER_SESSION_STATUS_LIVE_WAIT_MS ?? '').trim();
  const liveWaitParsed = liveWaitRaw ? Number.parseInt(liveWaitRaw, 10) : NaN;
  return Number.isFinite(liveWaitParsed) && liveWaitParsed > 0 ? Math.min(30_000, liveWaitParsed) : 3_000;
}

type HeldSessionMetadata =
  | Readonly<{ state: 'object'; metadataVersion: number; metadata: Record<string, unknown> }>
  | Readonly<{ state: 'malformed' | 'unreadable'; metadataVersion: number }>;

function readHeldSessionMetadata(
  target: Extract<Awaited<ReturnType<typeof resolveSessionTransportContext>>, { ok: true }>,
): HeldSessionMetadata {
  const metadataVersion = target.rawSession.metadataVersion;
  let metadata: unknown;
  try {
    metadata = target.mode === 'plain'
      ? JSON.parse(target.rawSession.metadata)
      : decryptSessionPayload({ ctx: target.ctx, ciphertextBase64: target.rawSession.metadata });
  } catch {
    return { state: 'unreadable', metadataVersion };
  }
  if (target.mode === 'e2ee' && metadata === null) {
    return { state: 'unreadable', metadataVersion };
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { state: 'malformed', metadataVersion };
  }
  return { state: 'object', metadataVersion, metadata: metadata as Record<string, unknown> };
}

// A reasoning-effort level is a short lowercase token (low, medium, xhigh, ...). Anything else is
// reported as invalid without its value.
const REASONING_EFFORT_LEVEL = /^[a-z][a-z0-9_-]{0,31}$/;
const REASONING_EFFORT_CONFIG_ID = 'reasoning_effort';

function readReportedModelState(metadata: Record<string, unknown>): RuntimeConfigPresent['reported'] {
  const state = readNewestSessionModelsMetadataStateV1(metadata);
  if (!state) {
    const published = [SESSION_MODELS_STATE_KEY, LEGACY_ACP_SESSION_MODELS_STATE_KEY]
      .some((key) => Object.prototype.hasOwnProperty.call(metadata, key));
    return published ? { state: 'invalid' } : { state: 'absent' };
  }
  const effort = state.availableModels
    .find((model) => model.id === state.currentModelId)
    ?.modelOptions?.find((option) => option.id === REASONING_EFFORT_CONFIG_ID)
    ?.currentValue;
  return {
    state: 'present',
    provider: state.provider,
    currentModelId: state.currentModelId,
    ...(typeof effort === 'string' && REASONING_EFFORT_LEVEL.test(effort) ? { reasoningEffort: effort } : {}),
    updatedAt: state.updatedAt,
  };
}

type RuntimeConfigPresent = Extract<SessionStatusResult['runtimeConfig'], { state: 'present' }>;

function readRuntimeConfig(held: HeldSessionMetadata): SessionStatusResult['runtimeConfig'] {
  if (held.state !== 'object') return { state: held.state, metadataVersion: held.metadataVersion };
  const model = resolveModelOverrideFromMetadataSnapshot({ metadata: held.metadata as Metadata });
  const effort = resolveSessionConfigOptionOverridesFromMetadataSnapshot({ metadata: held.metadata as Metadata })
    .find((option) => option.configId === REASONING_EFFORT_CONFIG_ID);
  return {
    state: 'present',
    metadataVersion: held.metadataVersion,
    desired: {
      ...(model ? { model } : {}),
      ...(effort
        ? {
            reasoningEffort: REASONING_EFFORT_LEVEL.test(effort.valueId)
              ? { state: 'present' as const, value: effort.valueId, updatedAt: effort.updatedAt }
              : { state: 'invalid' as const, updatedAt: effort.updatedAt },
          }
        : {}),
    },
    reported: readReportedModelState(held.metadata),
  };
}

function readUsageLimitRecovery(held: HeldSessionMetadata): SessionStatusResult['usageLimitRecovery'] {
  if (held.state !== 'object') return { state: held.state, metadataVersion: held.metadataVersion };
  const { metadata, metadataVersion } = held;
  if (!Object.prototype.hasOwnProperty.call(metadata, SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY)) {
    return { state: 'absent', metadataVersion };
  }
  const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(
    metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY],
  );
  if (!parsed.success) return { state: 'malformed', metadataVersion };
  const { status, issueFingerprint, armedAtMs, runtimeAuthRecoveryAttemptId } = parsed.data;
  return {
    state: 'present', metadataVersion,
    recovery: { status, issueFingerprint, armedAtMs,
      ...(runtimeAuthRecoveryAttemptId === undefined ? {} : { runtimeAuthRecoveryAttemptId }),
    },
  };
}

export async function getSessionStatus(params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
  live: boolean;
}>): Promise<GetSessionStatusResult> {
  const sessionTarget = await resolveSessionTransportContext({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
  });
  if (!sessionTarget.ok) {
    return {
      ok: false,
      code: sessionTarget.code,
      ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}),
    };
  }
  // Do not certify one session's recovery intent using another session's snapshot.
  if (sessionTarget.rawSession.id !== sessionTarget.sessionId) {
    return { ok: false, code: 'unsupported' };
  }

  const heldMetadata = readHeldSessionMetadata(sessionTarget);
  let agentStateSummary = summarizeSessionAgentState({
    sessionTarget,
  });

  if (params.live) {
    try {
      const liveSummary = await readLatestAgentStateSummaryViaSocket({
        token: params.credentials.token,
        sessionId: sessionTarget.sessionId,
        ctx: sessionTarget.ctx,
        sessionEncryptionMode: sessionTarget.mode,
        timeoutMs: resolveLiveStatusWaitMs(),
      });
      if (liveSummary) {
        agentStateSummary = liveSummary;
      }
    } catch {
      // Best-effort only; fall back to snapshot state.
    }
  }

  return {
    ok: true,
    session: summarizeSessionRecord({
      credentials: params.credentials,
      session: sessionTarget.rawSession,
    }),
    agentState: agentStateSummary,
    usageLimitRecovery: readUsageLimitRecovery(heldMetadata),
    runtimeConfig: readRuntimeConfig(heldMetadata),
  };
}
