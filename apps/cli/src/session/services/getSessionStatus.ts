import type { Credentials } from '@/persistence';
import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SessionUsageLimitRecoveryV1Schema,
  type SessionStatusResult,
} from '@happier-dev/protocol';
import { summarizeSessionRecord, type SessionSummary } from '@/cli/output/session/sessionSummary';
import { decryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import {
  readLatestAgentStateSummaryViaSocket,
  summarizeAgentState,
  type AgentStateSummary,
} from '@/session/transport/socket/sessionSocketAgentState';

import { resolveSessionTransportContext } from './resolveSessionTransportContext';

export type GetSessionStatusResult =
  | Readonly<{ ok: true; session: SessionSummary; agentState: AgentStateSummary | null; usageLimitRecovery: SessionStatusResult['usageLimitRecovery'] }>
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

function readUsageLimitRecovery(
  target: Extract<Awaited<ReturnType<typeof resolveSessionTransportContext>>, { ok: true }>,
): SessionStatusResult['usageLimitRecovery'] {
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
  if (!Object.prototype.hasOwnProperty.call(metadata, SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY)) {
    return { state: 'absent', metadataVersion };
  }
  const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(
    (metadata as Record<string, unknown>)[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY],
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
    usageLimitRecovery: readUsageLimitRecovery(sessionTarget),
  };
}
