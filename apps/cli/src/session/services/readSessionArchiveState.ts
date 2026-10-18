import { fetchSessionById } from '@/session/transport/http/sessionsHttp';

export type SessionArchiveState = 'unarchived' | 'archived' | 'unavailable';

/** A permission read must not join a snapshot request begun before this boundary. */
export async function readSessionArchiveState(params: Readonly<{
  token: string;
  sessionId: string;
  signal: AbortSignal;
}>): Promise<SessionArchiveState> {
  if (params.signal.aborted) return 'unavailable';
  try {
    const session = await fetchSessionById({ ...params, reason: 'prompt-dispatch-boundary' });
    if (params.signal.aborted || !session || session.id !== params.sessionId) return 'unavailable';
    if (session.archivedAt === null) return 'unarchived';
    if (typeof session.archivedAt === 'number') return 'archived';
    // Older/malformed responses without archive state are not permission to run.
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}
