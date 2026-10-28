import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveBoxPublicKeyFromSeed, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { encodeBase64, encrypt } from '@/api/encryption';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

const { fetchSessionById } = vi.hoisted(() => ({
    fetchSessionById: vi.fn(),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
    fetchSessionById,
}));

describe('resolveSessionTransportContext', () => {
    const prevRetryAttempts = process.env.HAPPIER_SESSION_E2EE_DEK_FETCH_RETRY_ATTEMPTS;
    const prevRetryDelayMs = process.env.HAPPIER_SESSION_E2EE_DEK_FETCH_RETRY_DELAY_MS;

    beforeEach(() => {
        fetchSessionById.mockReset();
        process.env.HAPPIER_SESSION_E2EE_DEK_FETCH_RETRY_ATTEMPTS = '2';
        process.env.HAPPIER_SESSION_E2EE_DEK_FETCH_RETRY_DELAY_MS = '1';
    });

    afterEach(() => {
        if (prevRetryAttempts === undefined) {
            delete process.env.HAPPIER_SESSION_E2EE_DEK_FETCH_RETRY_ATTEMPTS;
        } else {
            process.env.HAPPIER_SESSION_E2EE_DEK_FETCH_RETRY_ATTEMPTS = prevRetryAttempts;
        }

        if (prevRetryDelayMs === undefined) {
            delete process.env.HAPPIER_SESSION_E2EE_DEK_FETCH_RETRY_DELAY_MS;
        } else {
            process.env.HAPPIER_SESSION_E2EE_DEK_FETCH_RETRY_DELAY_MS = prevRetryDelayMs;
        }
    });

    it.each(['plain', 'legacy'] as const)('reuses the resolved %s session without another HTTP read', async (kind) => {
        const secret = new Uint8Array(32).fill(4);
        const session = createSessionRecordFixture({
            id: 'c123456789012345678901234',
            encryptionMode: kind === 'plain' ? 'plain' : 'e2ee',
            metadata: kind === 'plain' ? JSON.stringify({ path: '/project' }) : 'legacy metadata',
        });
        fetchSessionById.mockResolvedValue(session);
        const { resolveSessionTransportContext } = await import('./resolveSessionTransportContext');

        const result = await resolveSessionTransportContext({
            credentials: {
                token: 'token',
                encryption: kind === 'legacy'
                    ? { type: 'legacy', secret }
                    : { type: 'dataKey', publicKey: deriveBoxPublicKeyFromSeed(secret), machineKey: secret },
            },
            idOrPrefix: session.id,
        });

        expect(result).toMatchObject({ ok: true, sessionId: session.id, rawSession: session });
        expect(fetchSessionById).toHaveBeenCalledTimes(1);
    });

    it('uses the published key from the resolved session without another HTTP read', async () => {
        const machineKey = new Uint8Array(32).fill(7);
        const publicKey = deriveBoxPublicKeyFromSeed(machineKey);
        const sessionDataKey = new Uint8Array(32).fill(9);
        const session = createSessionRecordFixture({
            id: 'c123456789012345678901234',
            encryptionMode: 'e2ee',
            dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({
                dataKey: sessionDataKey,
                recipientPublicKey: publicKey,
                randomBytes: (length) => new Uint8Array(length).fill(3),
            }), 'base64'),
        });
        fetchSessionById.mockResolvedValue(session);
        const { resolveSessionTransportContext } = await import('./resolveSessionTransportContext');

        const result = await resolveSessionTransportContext({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey, machineKey } },
            idOrPrefix: session.id,
        });

        expect(result).toMatchObject({ ok: true, sessionId: session.id, rawSession: session });
        if (!result.ok) throw new Error('Expected resolved session transport context');
        if (result.ctx.encryptionVariant === 'plain') throw new Error('Expected encrypted session context');
        expect(Array.from(result.ctx.encryptionKey)).toEqual(Array.from(sessionDataKey));
        expect(fetchSessionById).toHaveBeenCalledTimes(1);
    });

    it('does not refetch a missing published key when metadata decrypts with the machine key', async () => {
        const machineKey = new Uint8Array(32).fill(7);
        const session = createSessionRecordFixture({
            id: 'c123456789012345678901234',
            encryptionMode: 'e2ee',
            metadata: encodeBase64(encrypt(machineKey, 'dataKey', { path: '/project' }), 'base64'),
        });
        fetchSessionById.mockResolvedValue(session);
        const { resolveSessionTransportContext } = await import('./resolveSessionTransportContext');

        const result = await resolveSessionTransportContext({
            credentials: { token: 'token', encryption: {
                type: 'dataKey', publicKey: deriveBoxPublicKeyFromSeed(machineKey), machineKey,
            } },
            idOrPrefix: session.id,
        });

        expect(result).toMatchObject({ ok: true, rawSession: session });
        expect(fetchSessionById).toHaveBeenCalledTimes(1);
    });

    it.each(['wrong recipient', 'malformed envelope'])('refuses a present DEK with %s', async (kind) => {
        const machineKey = new Uint8Array(32).fill(7);
        const dataEncryptionKey = kind === 'malformed envelope'
            ? encodeBase64(new Uint8Array([1, 2, 3]), 'base64')
            : encodeBase64(sealEncryptedDataKeyEnvelopeV1({
                dataKey: new Uint8Array(32).fill(9),
                recipientPublicKey: deriveBoxPublicKeyFromSeed(new Uint8Array(32).fill(8)),
                randomBytes: (length) => new Uint8Array(length).fill(3),
            }), 'base64');
        const session = createSessionRecordFixture({
            id: 'c123456789012345678901234', encryptionMode: 'e2ee', dataEncryptionKey,
        });
        fetchSessionById.mockResolvedValue(session);

        const { resolveSessionTransportContext } = await import('./resolveSessionTransportContext');
        const credentials = {
            token: 'token',
            encryption: { type: 'dataKey' as const, machineKey, publicKey: deriveBoxPublicKeyFromSeed(machineKey) },
        };
        // Non-send consumers retain their original fallback and result contract.
        expect(await resolveSessionTransportContext({ credentials, idOrPrefix: session.id }))
            .toMatchObject({ ok: true, ctx: { encryptionKey: machineKey, encryptionVariant: 'dataKey' } });
        expect(await resolveSessionTransportContext({
            credentials,
            idOrPrefix: session.id,
            requireOpenSessionDataKey: true,
        })).toEqual({ ok: false, code: 'session_data_key_unopenable', sessionId: session.id });
    });

    it('refetches active e2ee sessions when the published dataEncryptionKey is briefly missing', async () => {
        const machineKey = new Uint8Array(32).fill(7);
        const publicKey = deriveBoxPublicKeyFromSeed(machineKey);
        const sessionDataKey = new Uint8Array(32).fill(9);
        const encryptedMetadata = encodeBase64(
            encrypt(sessionDataKey, 'dataKey', { path: '/tmp/project', permissionMode: 'safe-yolo' }),
            'base64',
        );
        const publishedDataEncryptionKey = encodeBase64(
            sealEncryptedDataKeyEnvelopeV1({
                dataKey: sessionDataKey,
                recipientPublicKey: publicKey,
                randomBytes: (length) => new Uint8Array(length).fill(3),
            }),
            'base64',
        );

        const sessionId = 'c123456789012345678901234';
        fetchSessionById
            .mockResolvedValueOnce(createSessionRecordFixture({
                id: sessionId,
                active: true,
                activeAt: 1,
                encryptionMode: 'e2ee',
                dataEncryptionKey: null,
                metadata: encryptedMetadata,
            }))
            .mockResolvedValueOnce(createSessionRecordFixture({
                id: sessionId,
                active: true,
                activeAt: 1,
                encryptionMode: 'e2ee',
                dataEncryptionKey: publishedDataEncryptionKey,
                metadata: encryptedMetadata,
            }));

        const { resolveSessionTransportContext } = await import('./resolveSessionTransportContext');

        const result = await resolveSessionTransportContext({
            credentials: {
                token: 'token',
                encryption: {
                    type: 'dataKey',
                    publicKey,
                    machineKey,
                },
            },
            idOrPrefix: sessionId,
        });

        expect(fetchSessionById).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({
            ok: true,
            sessionId,
            mode: 'e2ee',
        });
        if (!result.ok) {
            throw new Error(`Expected resolved session transport context, got ${JSON.stringify(result)}`);
        }
        if (result.ctx.encryptionVariant === 'plain') throw new Error('Expected encrypted context');
        expect(Array.from(result.ctx.encryptionKey)).toEqual(Array.from(sessionDataKey));
    });
});
