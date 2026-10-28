import type { TerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';

import type { TrackedSession } from '../types';
import type { SessionRunnerServiceabilityProbe } from './isSessionRunnerActive';
import {
  hasActiveReportedTerminalControlServiceability,
  shouldPublishReportedTerminalControlServiceability,
} from './terminalControlServiceabilityProjection';

export async function publishReportedTerminalControlServiceability(params: Readonly<{
  tracked: TrackedSession;
  readTerminalAttachmentInfo: (sessionId: string) => Promise<TerminalAttachmentInfo | null>;
  probeSessionRunnerServiceability: (sessionId: string) => Promise<SessionRunnerServiceabilityProbe>;
  publishSessionRunnerControlServiceability: (
    sessionId: string,
    probe: SessionRunnerServiceabilityProbe,
  ) => Promise<boolean>;
}>): Promise<void> {
  const sessionId = typeof params.tracked.happySessionId === 'string'
    ? params.tracked.happySessionId.trim()
    : '';
  const terminal = params.tracked.happySessionMetadataFromLocalWebhook?.terminal;
  if (!sessionId || !terminal || terminal.mode === 'plain') return;

  const attachment = await params.readTerminalAttachmentInfo(sessionId);
  if (!attachment || attachment.version === 1) return;

  if (hasActiveReportedTerminalControlServiceability({ terminal, attachmentId: attachment.attachmentId })) {
    params.tracked.publishedTerminalControlServiceabilityAttachmentId = attachment.attachmentId;
    params.tracked.publishedTerminalControlServiceabilityAttachmentLifecycle =
      attachment.version === 3 ? 'borrowed' : 'owned';
    return;
  }

  if (
    !shouldPublishReportedTerminalControlServiceability({
      terminal,
      attachmentId: attachment.attachmentId,
      publishedAttachmentId: params.tracked.publishedTerminalControlServiceabilityAttachmentId,
    })
  ) {
    return;
  }

  const probe = await params.probeSessionRunnerServiceability(sessionId);
  const published = await params.publishSessionRunnerControlServiceability(sessionId, probe);
  if (published && probe.state === 'runner_present' && probe.control.state === 'servable') {
    params.tracked.publishedTerminalControlServiceabilityAttachmentId = attachment.attachmentId;
    params.tracked.publishedTerminalControlServiceabilityAttachmentLifecycle =
      attachment.version === 3 ? 'borrowed' : 'owned';
  }
}
