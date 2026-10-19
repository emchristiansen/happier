import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';

export type SessionArchiveState =
  | Readonly<{ kind: 'unarchived' | 'archived' }>
  | Readonly<{ kind: 'unavailable'; retryAfterMs?: number }>;

/** A permission read must not join a snapshot request begun before this boundary. */
export async function readSessionArchiveState(params: Readonly<{
  token: string;
  sessionId: string;
  signal: AbortSignal;
}>): Promise<SessionArchiveState> {
  if (params.signal.aborted) return { kind: 'unavailable' };
  try {
    const session = await fetchSessionById({ ...params, reason: 'prompt-dispatch-boundary' });
    if (params.signal.aborted || !session || session.id !== params.sessionId) return { kind: 'unavailable' };
    if (session.archivedAt === null) return { kind: 'unarchived' };
    if (typeof session.archivedAt === 'number') return { kind: 'archived' };
    // Older/malformed responses without archive state are not permission to run.
    return { kind: 'unavailable' };
  } catch (error) {
    // Guidance belongs to this physical permission request, including after an epoch change.
    const { retryAfterMs } = classifyServerEndpointError(error);
    return { kind: 'unavailable', ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  }
}
