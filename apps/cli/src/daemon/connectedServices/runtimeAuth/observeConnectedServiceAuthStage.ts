import { logger } from '@/ui/logger';

export type ConnectedServiceAuthStageContext = Readonly<{
  sessionId: string | null;
  bindings: ReadonlyArray<Readonly<{ serviceId: string; profileId?: string; groupId?: string }>>;
}>;

type ConnectedServiceAuthStage =
  | 'session_lock_wait'
  | 'profile_normalization'
  | 'materializer'
  | 'credential_write_commit'
  | 'continuity'
  | 'descriptor_lookup';

export function beginConnectedServiceAuthStage(
  context: ConnectedServiceAuthStageContext,
  stage: ConnectedServiceAuthStage,
): () => void {
  const record = {
    sessionId: context.sessionId,
    bindings: context.bindings.map(({ serviceId, profileId, groupId }) => ({
      serviceId,
      ...(profileId === undefined ? {} : { profileId }),
      ...(groupId === undefined ? {} : { groupId }),
    })),
    stage,
  };
  logger.infoFile('[DAEMON RUN] Connected-service auth stage', { ...record, phase: 'begin' });
  let ended = false;
  return () => {
    // Lock acquisition ends its wait before the enclosing operation settles;
    // the enclosing finally also closes a wait that rejected before acquisition.
    if (ended) return;
    ended = true;
    logger.infoFile('[DAEMON RUN] Connected-service auth stage', { ...record, phase: 'end' });
  };
}

export async function observeConnectedServiceAuthStage<T>(
  context: ConnectedServiceAuthStageContext,
  stage: ConnectedServiceAuthStage,
  operation: () => Promise<T>,
): Promise<T> {
  const end = beginConnectedServiceAuthStage(context, stage);
  try {
    return await operation();
  } finally {
    end();
  }
}
