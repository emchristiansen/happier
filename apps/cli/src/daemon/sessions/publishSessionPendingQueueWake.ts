import type { PendingQueueBlockingHeadV1 } from '@happier-dev/protocol';

import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { logger } from '@/ui/logger';

import type { SessionPendingQueueWakeDiagnostic } from './pendingQueueWake';

export function publishSessionPendingQueueWake(params: Readonly<{
  sessionId: string;
  isShutdownRequested: () => boolean;
  logLabel: string;
  requestWake: () => Promise<SessionPendingQueueWakeDiagnostic>;
  /**
   * Reads the queue head the server reports in session state as holding ordinary input back, after
   * a published wake. The daemon only logs it; resolving a held head stays a manual act.
   */
  readBlockingHead?: () => Promise<PendingQueueBlockingHeadV1 | null | undefined>;
}>): void {
  if (params.isShutdownRequested()) return;
  void params.requestWake().then((diagnostic) => {
    const context = {
      event: 'pending_queue_wake' as const,
      sessionId: params.sessionId,
      trigger: params.logLabel,
    };
    if (diagnostic.type === 'unavailable') {
      logger.warn('[DAEMON RUN] Pending queue wake unavailable', {
        ...context,
        outcome: 'unavailable',
        reason: diagnostic.reason,
      });
      return;
    }
    logger.infoFile('[DAEMON RUN] Pending queue wake published', {
      ...context,
      outcome: 'published',
    });
    if (params.readBlockingHead) logReportedBlockingHead(params, params.readBlockingHead);
  }, (error) => {
    logger.warn('[DAEMON RUN] Pending queue wake failed', {
      event: 'pending_queue_wake',
      sessionId: params.sessionId,
      trigger: params.logLabel,
      outcome: 'error',
    });
    logger.debug(`[DAEMON RUN] ${params.logLabel} pending queue wake failed`, {
      sessionId: params.sessionId,
      error: serializeAxiosErrorForLog(error),
    });
  });
}

function logReportedBlockingHead(
  params: Readonly<{ sessionId: string; logLabel: string }>,
  readBlockingHead: () => Promise<PendingQueueBlockingHeadV1 | null | undefined>,
): void {
  void readBlockingHead().then((head) => {
    if (!head) return;
    logger.infoFile('[DAEMON RUN] Pending queue head is holding back ordinary pending input', {
      event: 'pending_queue_blocking_head',
      sessionId: params.sessionId,
      trigger: params.logLabel,
      localId: head.localId,
      deliveryState: head.deliveryState,
      blockedReason: head.deliveryState === 'blocked' ? head.blockedReason : null,
      lastUpdatedAt: head.lastUpdatedAt,
      ageSinceLastUpdateMs: head.ageSinceLastUpdateMs,
    });
  }, (error) => {
    logger.debug('[DAEMON RUN] Pending queue blocking head read failed', {
      sessionId: params.sessionId,
      trigger: params.logLabel,
      error: serializeAxiosErrorForLog(error),
    });
  });
}
