import axios from 'axios';
import { readPendingLocalId } from '@happier-dev/protocol';

import { SessionMessageContentSchema, type Update } from '../types';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';
import {
    createAuthenticationHttpStatusError,
    isAuthenticationStatus,
    readAuthenticationStatus,
} from '../client/httpStatusError';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';

type SessionHistoryReplayProvenance = Readonly<{
    sourceCreatedAt: number | null;
    sourceUpdatedAt: number | null;
}>;

// Catch-up classification stays out of band so a remote row cannot forge "history" provenance.
const sessionHistoryReplayProvenance = new WeakMap<object, SessionHistoryReplayProvenance>();

export function readSessionHistoryReplayProvenance(update: Update): SessionHistoryReplayProvenance | null {
    return sessionHistoryReplayProvenance.get(update as object) ?? null;
}

function readCatchUpTimestamp(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

export async function catchUpSessionMessagesAfterSeq(params: {
    token: string;
    sessionId: string;
    afterSeq: number;
    onUpdate: (update: Update) => void;
}): Promise<void> {
    let cursor = Number.isFinite(params.afterSeq) && params.afterSeq >= 0 ? Math.floor(params.afterSeq) : 0;
    const serverUrl = resolveServerHttpBaseUrl();
    while (true) {
        const pageAfterSeq = cursor;
        let response;
        try {
            response = await axios.get(`${serverUrl}/v1/sessions/${params.sessionId}/messages`, {
                headers: {
                    Authorization: `Bearer ${params.token}`,
                    'Content-Type': 'application/json',
                },
                params: {
                    afterSeq: cursor,
                    limit: 200,
                },
                timeout: 15_000,
            });
        } catch (error) {
            const status = readAuthenticationStatus(error);
            if (status) {
                throw createAuthenticationHttpStatusError(
                    status,
                    `Authentication failed during session message catch-up (HTTP ${status})`,
                );
            }
            throw error;
        }
        const status = response?.status;
        if (isAuthenticationStatus(status)) {
            throw createAuthenticationHttpStatusError(
                status,
                `Authentication failed during session message catch-up (HTTP ${status})`,
            );
        }

        const messages = (response?.data as any)?.messages;
        const nextAfterSeq = (response?.data as any)?.nextAfterSeq;
        if (!Array.isArray(messages) || messages.length === 0) {
            return;
        }

        for (const msg of messages) {
            if (!msg || typeof msg !== 'object') continue;
            const id = (msg as any).id;
            const seq = (msg as any).seq;
            const content = (msg as any).content;
            if (typeof id !== 'string' || typeof seq !== 'number') continue;
            const parsedContent = SessionMessageContentSchema.safeParse(content);
            if (!parsedContent.success) continue;

            const localIdRaw = (msg as any).localId;
            const localId = readPendingLocalId(localIdRaw);
            const sidechainIdRaw = (msg as any).sidechainId;
            const sidechainId = readNonBlankOpaqueIdentifier(sidechainIdRaw);
            const createdAt = readCatchUpTimestamp((msg as any).createdAt);
            const updatedAt = readCatchUpTimestamp((msg as any).updatedAt) ?? createdAt;

            const update: Update = {
                id: `catchup-${id}`,
                seq: 0,
                createdAt,
                body: {
                    t: 'new-message',
                    sid: params.sessionId,
                    message: {
                        id,
                        seq,
                        localId,
                        sidechainId,
                        content: parsedContent.data,
                        createdAt,
                        updatedAt,
                    },
                },
            } as Update;

            sessionHistoryReplayProvenance.set(update as object, {
                sourceCreatedAt: createdAt,
                sourceUpdatedAt: updatedAt,
            });

            params.onUpdate(update);
            cursor = Math.max(cursor, seq);
        }

        if (typeof nextAfterSeq === 'number' && Number.isFinite(nextAfterSeq) && nextAfterSeq > pageAfterSeq) {
            cursor = Math.max(cursor, nextAfterSeq);
            continue;
        }
        return;
    }
}
