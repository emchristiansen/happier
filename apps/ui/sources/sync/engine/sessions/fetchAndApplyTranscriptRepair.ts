import { buildSessionMessagesPath } from '@/sync/api/session/sessionMessagesApi';
import { runSessionMessagesPagePipeline } from './sessionMessagesPagePipeline';

type PagePipelineParams = Parameters<typeof runSessionMessagesPagePipeline>[0];

/** Repairs bounded sequence ranges without taking ownership of the visible window or tail cursor. */
export async function fetchAndApplyTranscriptRepair(params: Omit<
    PagePipelineParams,
    'purpose' | 'page' | 'lifecyclePolicy' | 'onMessagesPage' | 'onTaskLifecycleEvent'
> & {
    targets: readonly Readonly<{ messageId: string; seq: number }>[];
    pageSize: number;
}): Promise<ReadonlySet<string>> {
    const targets = [...params.targets].sort((left, right) => left.seq - right.seq);
    const resolvedMessageIds = new Set<string>();
    for (let start = 0; start < targets.length;) {
        let end = start + 1;
        // The configured history page size also bounds repair work. Adjacent edits share
        // one request; sparse edits start another range instead of walking the gap.
        while (end < targets.length && targets[end].seq - targets[start].seq < params.pageSize) end++;
        const afterSeq = targets[start].seq - 1;
        // AccountChange coalesces session hints, so earlier edited identities may be
        // absent. Preserve the old first page's refresh of known neighbors; the
        // pipeline excludes unseen unrequested rows without consuming its cursor.
        const limit = params.pageSize;
        const targetIds = new Set(targets.slice(start, end).map((target) => target.messageId));
        const result = await runSessionMessagesPagePipeline({
            ...params,
            messageIds: targetIds,
            purpose: 'target-window',
            page: {
                direction: 'newer', scope: 'all', afterSeq, limit,
                requestPath: buildSessionMessagesPath({ sessionId: params.sessionId, scope: 'all', afterSeq, limit }),
            },
            lifecyclePolicy: 'suppress',
        });
        // A successful pipeline commits revisions after application. A row omitted by
        // dedupe is still repaired when the same or a newer revision is already present.
        const received = params.sessionReceivedMessages.get(params.sessionId);
        for (const message of result.page.messages) {
            if (!targetIds.has(message.id)) continue;
            const revision = received?.get(message.id);
            if (revision !== undefined && revision >= (message.updatedAt ?? message.createdAt)) {
                resolvedMessageIds.add(message.id);
            }
        }
        start = end;
    }
    return resolvedMessageIds;
}
