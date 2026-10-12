import { isDeepStrictEqual } from 'node:util';
import { normalizeSessionMetadataForRead, projectSessionMetadataForWire } from '@happier-dev/protocol';
import type { Socket } from 'socket.io-client';

import { createAuthenticationHttpStatusError, isAuthenticationError } from '@/api/client/httpStatusError';
import { createSessionScopedSocket } from '@/api/session/sockets';
import type { Credentials } from '@/persistence';
import {
  decryptStoredSessionPayload,
  encryptStoredSessionPayload,
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { patchSessionMetadata } from '@/session/transport/http/sessionsHttp';
import { waitForSocketConnect } from '@/session/transport/socket/waitForSocketConnect';
import { resolveSessionControlSocketConnectTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import { emitSocketCallbackAck } from '@/session/transport/shared/socketAck';

type UpdateMetadataAck =
  | { result: 'success'; version: number; metadata: string }
  | { result: 'version-mismatch'; version: number; metadata: string }
  | { result: 'forbidden' }
  | { result: 'error' };

type MetadataUpdateErrorCode = 'unsupported' | 'unknown_error' | 'conflict';

function createMetadataUpdateError(message: string, code: MetadataUpdateErrorCode): Error & { code: MetadataUpdateErrorCode } {
  return Object.assign(new Error(message), { code });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return normalizeSessionMetadataForRead(value as Record<string, unknown>);
}

function cloneMetadataRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function isRetryableSocketMetadataTransportError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: unknown; retryable?: unknown };
  return (
    record.retryable === true
    && (record.code === 'socket_not_connected' || record.code === 'socket_ack_timeout')
  );
}

async function backoffMetadataRetry(attempt: number, maxAttempts: number): Promise<void> {
  if (attempt >= maxAttempts - 1) return;
  await new Promise((r) => setTimeout(r, Math.min(50 * (attempt + 1), 250)));
}

async function emitUpdateMetadataWithAck(socket: Socket, payload: { sid: string; expectedVersion: number; metadata: string }): Promise<UpdateMetadataAck> {
  const res = await emitSocketCallbackAck<UpdateMetadataAck>({
    socket: socket as any,
    event: 'update-metadata',
    payload,
  });
  return res;
}

export async function updateSessionMetadataWithRetry(params: Readonly<{
  token: string;
  credentials: Credentials;
  sessionId: string;
  rawSession: Readonly<{ metadata: string; metadataVersion: number; encryptionMode?: unknown; dataEncryptionKey?: unknown }>;
  updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
  maxAttempts?: number;
}>): Promise<{ version: number; metadata: Record<string, unknown> }> {
  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, params.rawSession);

  let expectedVersion = params.rawSession.metadataVersion;
  let currentWireValue = String(params.rawSession.metadata ?? '').trim();

  const initialDecrypted = asRecord(decryptStoredSessionPayload({ mode, ctx, value: currentWireValue }));
  if (!initialDecrypted) {
    throw createMetadataUpdateError('Unsupported session metadata payload', 'unsupported');
  }
  let currentDecrypted: Record<string, unknown> = initialDecrypted;
  const maxAttempts = typeof params.maxAttempts === 'number' && Number.isFinite(params.maxAttempts) && params.maxAttempts > 0 ? Math.min(10, params.maxAttempts) : 6;

  const computeChangedMetadata = (): Record<string, unknown> | null => {
    const updated = params.updater(cloneMetadataRecord(currentDecrypted));
    return isDeepStrictEqual(updated, currentDecrypted) ? null : updated;
  };
  let pendingChangedMetadata: Record<string, unknown> | null | undefined = computeChangedMetadata();
  if (pendingChangedMetadata === null) {
    return { version: expectedVersion, metadata: currentDecrypted };
  }
  const takeChangedMetadata = (): Record<string, unknown> | null => {
    if (pendingChangedMetadata !== undefined) {
      const result = pendingChangedMetadata;
      pendingChangedMetadata = undefined;
      return result;
    }
    return computeChangedMetadata();
  };

  const updateViaHttpPatch = async (): Promise<{ version: number; metadata: Record<string, unknown> }> => {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const updated = takeChangedMetadata();
      if (updated === null) {
        return { version: expectedVersion, metadata: currentDecrypted };
      }
      const updatedWireValue = encryptStoredSessionPayload({ mode, ctx, payload: projectSessionMetadataForWire(updated) });

      const result = await patchSessionMetadata({
        token: params.token,
        sessionId: params.sessionId,
        expectedVersion,
        ciphertext: updatedWireValue,
      });

      if (result.success) {
        return { version: result.version, metadata: updated };
      }

      expectedVersion = result.current.version;
      currentWireValue = String(result.current.value ?? '').trim();
      const next = asRecord(decryptStoredSessionPayload({ mode, ctx, value: currentWireValue }));
      if (!next) {
        throw createMetadataUpdateError('Unsupported session metadata payload', 'unsupported');
      }
      currentDecrypted = next;
      pendingChangedMetadata = undefined;
      await backoffMetadataRetry(attempt, maxAttempts);
    }

    throw createMetadataUpdateError('Metadata update conflict', 'conflict');
  };

  const socket = createSessionScopedSocket({ token: params.token, sessionId: params.sessionId }) as unknown as Socket;

  try {
    try {
      const connectPromise = waitForSocketConnect(socket, resolveSessionControlSocketConnectTimeoutMs());
      socket.connect();
      await connectPromise;
    } catch (error) {
      if (isAuthenticationError(error)) {
        throw error;
      }
      return await updateViaHttpPatch();
    }

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const updated = takeChangedMetadata();
      if (updated === null) {
        return { version: expectedVersion, metadata: currentDecrypted };
      }
      const updatedWireValue = encryptStoredSessionPayload({ mode, ctx, payload: projectSessionMetadataForWire(updated) });

      let ack: UpdateMetadataAck;
      try {
        ack = await emitUpdateMetadataWithAck(socket, {
          sid: params.sessionId,
          expectedVersion,
          metadata: updatedWireValue,
        });
      } catch (error) {
        if (isAuthenticationError(error) || !isRetryableSocketMetadataTransportError(error)) {
          throw error;
        }
        return await updateViaHttpPatch();
      }

      if (ack && ack.result === 'success') {
        const next = asRecord(decryptStoredSessionPayload({ mode, ctx, value: String(ack.metadata ?? '') }));
        return { version: ack.version, metadata: next ?? updated };
      }

      if (ack && ack.result === 'version-mismatch') {
        expectedVersion = ack.version;
        currentWireValue = String(ack.metadata ?? '').trim();
        const next = asRecord(decryptStoredSessionPayload({ mode, ctx, value: currentWireValue }));
        if (next) currentDecrypted = next;
        pendingChangedMetadata = undefined;
        await backoffMetadataRetry(attempt, maxAttempts);
        continue;
      }

      if (ack && ack.result === 'forbidden') {
        throw createAuthenticationHttpStatusError(403, 'Forbidden');
      }

      throw createMetadataUpdateError('Metadata update failed', 'unknown_error');
    }

    throw createMetadataUpdateError('Metadata update conflict', 'conflict');
  } finally {
    try {
      socket.disconnect();
      socket.close();
    } catch {
      // ignore
    }
  }
}
