import axios from 'axios';
import { randomUUID } from 'node:crypto';

import { ApprovalRequestV1Schema, type ApprovalRequestV1 } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import {
  fetchArtifactRecord,
  openArtifactDataEncryptionKey,
  sealArtifactDataEncryptionKey,
  updateArtifactRecord,
  type ArtifactFullRecord,
} from '@/api/artifacts/artifactRecords';
import {
  decodeBase64,
  decryptWithDataKey,
  encodeBase64,
  encryptWithDataKey,
  getRandomBytes,
} from '@/api/encryption';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

type ArtifactCreateRequest = Readonly<{
  id: string;
  header: string;
  body: string;
  dataEncryptionKey: string;
}>;

function buildApprovalArtifactHeader(request: ApprovalRequestV1): Record<string, unknown> {
  const sessionId = typeof request.createdBy.sessionId === 'string' ? request.createdBy.sessionId.trim() : '';
  return {
    v: 1,
    kind: 'approval_request.v1',
    title: request.summary,
    approvalStatus: request.status,
    actionId: request.actionId,
    ...(sessionId ? { sessions: [sessionId], sessionId } : {}),
  };
}

// Approvals keep their established collapse: an unreadable record reads as absent; a transport failure propagates.
async function fetchApprovalArtifactRecord(params: Readonly<{
  credentials: Credentials;
  artifactId: string;
}>): Promise<ArtifactFullRecord | null> {
  const fetched = await fetchArtifactRecord(params);
  if (fetched.ok) return fetched.record;
  if (fetched.error.code === 'network') throw fetched.error.cause;
  return null;
}

async function createArtifact(params: Readonly<{
  credentials: Credentials;
  request: ArtifactCreateRequest;
}>): Promise<{ ok: true; artifactId: string } | { ok: false }> {
  const response = await axios.post(`${resolveServerHttpBaseUrl()}/v1/artifacts`, params.request, {
    headers: {
      Authorization: `Bearer ${params.credentials.token}`,
      'Content-Type': 'application/json',
    },
    timeout: 15_000,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) return { ok: false };
  const record = response.data as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : params.request.id;
  return { ok: true, artifactId: id };
}

export function createCliApprovalsArtifactStore(params: Readonly<{ credentials: Credentials }>): Readonly<{
  approvalsCreate: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['approvalsCreate']>;
  approvalsGet: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['approvalsGet']>;
  approvalsUpdate: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['approvalsUpdate']>;
}> {
  return {
    approvalsCreate: async ({ request, serverId }) => {
      const artifactId = randomUUID();
      const dataEncryptionKey = getRandomBytes(32);
      const encryptedKey = await sealArtifactDataEncryptionKey({ credentials: params.credentials, dataEncryptionKey });

      const header = {
        ...buildApprovalArtifactHeader(request),
        ...(typeof serverId === 'string' && serverId.trim().length > 0 ? { serverId: serverId.trim() } : {}),
      };
      const encryptedHeader = encodeBase64(encryptWithDataKey(header, dataEncryptionKey), 'base64');
      const encryptedBody = encodeBase64(encryptWithDataKey({ body: JSON.stringify(request) }, dataEncryptionKey), 'base64');

      const res = await createArtifact({
        credentials: params.credentials,
        request: {
          id: artifactId,
          header: encryptedHeader,
          body: encryptedBody,
          dataEncryptionKey: encryptedKey,
        },
      });
      if (!res.ok) {
        throw new Error('approval_request_create_failed');
      }
      return { artifactId: res.artifactId };
    },

    approvalsGet: async ({ artifactId }) => {
      const artifact = await fetchApprovalArtifactRecord({ credentials: params.credentials, artifactId });
      if (!artifact) return null;

      const dataEncryptionKey = await openArtifactDataEncryptionKey({
        credentials: params.credentials,
        encryptedDataEncryptionKeyBase64: artifact.dataEncryptionKey,
      });
      if (!dataEncryptionKey) return null;

      const decrypted = decryptWithDataKey(decodeBase64(artifact.body), dataEncryptionKey) as { body?: unknown } | null;
      const body = typeof decrypted?.body === 'string' ? decrypted.body : null;
      if (!body) return null;

      try {
        const parsed = ApprovalRequestV1Schema.safeParse(JSON.parse(body));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },

    approvalsUpdate: async ({ artifactId, request, serverId }) => {
      const artifact = await fetchApprovalArtifactRecord({ credentials: params.credentials, artifactId });
      if (!artifact) return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' };

      const dataEncryptionKey = await openArtifactDataEncryptionKey({
        credentials: params.credentials,
        encryptedDataEncryptionKeyBase64: artifact.dataEncryptionKey,
      });
      if (!dataEncryptionKey) return { ok: false, errorCode: 'invalid_parameters', error: 'artifact_key_unavailable' };

      const header = {
        ...buildApprovalArtifactHeader(request),
        ...(typeof serverId === 'string' && serverId.trim().length > 0 ? { serverId: serverId.trim() } : {}),
      };
      const encryptedHeader = encodeBase64(encryptWithDataKey(header, dataEncryptionKey), 'base64');
      const encryptedBody = encodeBase64(encryptWithDataKey({ body: JSON.stringify(request) }, dataEncryptionKey), 'base64');

      const updated = await updateArtifactRecord({
        credentials: params.credentials,
        artifactId,
        request: {
          header: encryptedHeader,
          expectedHeaderVersion: artifact.headerVersion,
          body: encryptedBody,
          expectedBodyVersion: artifact.bodyVersion,
        },
      });

      if (updated.ok) return { ok: true };
      switch (updated.error.code) {
        case 'network':
          throw updated.error.cause;
        case 'not_found':
          return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' };
        case 'version_mismatch':
          return { ok: false, errorCode: 'version_mismatch', error: 'artifact_version_mismatch' };
        default:
          return { ok: false, errorCode: 'update_failed', error: 'artifact_update_failed' };
      }
    },
  };
}
