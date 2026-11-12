import axios from 'axios';
import { z } from 'zod';

import {
  lazySchema,
  openEncryptedDataKeyEnvelopeV1,
  sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';

import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import {
  decodeBase64,
  encodeBase64,
  getRandomBytes,
  libsodiumPublicKeyFromSecretKey,
} from '@/api/encryption';
import { requireEncryptionCredentials, type Credentials } from '@/persistence';
import { deriveKey } from '@/utils/deriveKey';

/**
 * Canonical CLI owner for single-artifact server records: the exact `GET /v1/artifacts/:id` read, the
 * versioned `POST /v1/artifacts/:id` compare-and-set update, and the per-artifact data-key envelope.
 * Callers decide how to interpret failures; this module never collapses one failure class into another.
 */

const REQUEST_TIMEOUT_MS = 15_000;

const ArtifactFullRecordSchema = lazySchema(() => z.object({
  id: z.string(),
  header: z.string(),
  headerVersion: z.number().int(),
  body: z.string(),
  bodyVersion: z.number().int(),
  dataEncryptionKey: z.string(),
  seq: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
}));

export type ArtifactFullRecord = z.infer<typeof ArtifactFullRecordSchema>;

const ArtifactUpdateResponseSchema = lazySchema(() => z.union([
  z.object({
    success: z.literal(true),
    headerVersion: z.number().int().optional(),
    bodyVersion: z.number().int().optional(),
  }),
  z.object({
    success: z.literal(false),
    error: z.literal('version-mismatch'),
    currentHeaderVersion: z.number().int().optional(),
    currentBodyVersion: z.number().int().optional(),
  }),
]));

export type ArtifactRequestError =
  | Readonly<{ code: 'invalid_artifact_id' }>
  | Readonly<{ code: 'not_found' }>
  | Readonly<{ code: 'http_status'; status: number }>
  | Readonly<{ code: 'network'; message: string; cause: unknown }>
  | Readonly<{ code: 'invalid_response'; message: string }>;

export type ArtifactRecordFetchResult =
  | Readonly<{ ok: true; record: ArtifactFullRecord }>
  | Readonly<{ ok: false; error: ArtifactRequestError }>;

export type ArtifactUpdateRequest = Readonly<
  | { header: string; expectedHeaderVersion: number; body: string; expectedBodyVersion: number }
  | { header: string; expectedHeaderVersion: number }
  | { body: string; expectedBodyVersion: number }
>;

export type ArtifactUpdateError =
  | ArtifactRequestError
  | Readonly<{ code: 'version_mismatch'; currentHeaderVersion: number | null; currentBodyVersion: number | null }>;

export type ArtifactUpdateResult =
  | Readonly<{ ok: true; headerVersion: number | null; bodyVersion: number | null }>
  | Readonly<{ ok: false; error: ArtifactUpdateError }>;

/**
 * Whether `artifactId` addresses exactly one `/v1/artifacts/:id` resource. Artifact ids are opaque server strings
 * (usually UUIDs), so this only refuses values that cannot name one: empty, surrounding whitespace, control
 * characters, and the `.`/`..` segments that URL resolution turns into a different path despite percent-encoding.
 */
export function isArtifactRecordId(artifactId: string): boolean {
  return artifactId.length > 0
    && artifactId !== '.'
    && artifactId !== '..'
    && artifactId.trim() === artifactId
    && !/[\u0000-\u001f\u007f]/u.test(artifactId);
}

function artifactUrl(artifactId: string): string {
  return `${resolveServerHttpBaseUrl()}/v1/artifacts/${encodeURIComponent(artifactId)}`;
}

/**
 * Both requests target exactly the selected artifact. A redirect is never followed: it is reported as its own
 * `http_status`, so neither the bearer token nor an encrypted body is sent to another resource.
 */
function exactArtifactRequestConfig(credentials: Credentials) {
  return {
    headers: authorizedJsonHeaders(credentials),
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 0,
    validateStatus: () => true,
  };
}

function authorizedJsonHeaders(credentials: Credentials): Record<string, string> {
  return {
    Authorization: `Bearer ${credentials.token}`,
    'Content-Type': 'application/json',
  };
}

function networkError(error: unknown): ArtifactRequestError {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'network', message: typeof code === 'string' ? `${code}: ${message}` : message, cause: error };
}

function statusError(status: number): ArtifactRequestError {
  return status === 404 ? { code: 'not_found' } : { code: 'http_status', status };
}

export async function fetchArtifactRecord(params: Readonly<{
  credentials: Credentials;
  artifactId: string;
}>): Promise<ArtifactRecordFetchResult> {
  if (!isArtifactRecordId(params.artifactId)) return { ok: false, error: { code: 'invalid_artifact_id' } };
  let response;
  try {
    response = await axios.get(artifactUrl(params.artifactId), exactArtifactRequestConfig(params.credentials));
  } catch (error) {
    return { ok: false, error: networkError(error) };
  }

  if (response.status < 200 || response.status >= 300) return { ok: false, error: statusError(response.status) };

  const parsed = ArtifactFullRecordSchema.safeParse(response.data);
  if (!parsed.success) {
    return { ok: false, error: { code: 'invalid_response', message: 'artifact record does not match the server contract' } };
  }
  if (parsed.data.id !== params.artifactId) {
    return { ok: false, error: { code: 'invalid_response', message: 'artifact record id differs from the requested id' } };
  }
  return { ok: true, record: parsed.data };
}

export async function updateArtifactRecord(params: Readonly<{
  credentials: Credentials;
  artifactId: string;
  request: ArtifactUpdateRequest;
}>): Promise<ArtifactUpdateResult> {
  if (!isArtifactRecordId(params.artifactId)) return { ok: false, error: { code: 'invalid_artifact_id' } };
  let response;
  try {
    response = await axios.post(artifactUrl(params.artifactId), params.request, exactArtifactRequestConfig(params.credentials));
  } catch (error) {
    return { ok: false, error: networkError(error) };
  }

  if (response.status < 200 || response.status >= 300) return { ok: false, error: statusError(response.status) };

  const parsed = ArtifactUpdateResponseSchema.safeParse(response.data);
  if (!parsed.success) {
    return { ok: false, error: { code: 'invalid_response', message: 'artifact update response does not match the server contract; the update outcome is unknown' } };
  }
  if (parsed.data.success) {
    return { ok: true, headerVersion: parsed.data.headerVersion ?? null, bodyVersion: parsed.data.bodyVersion ?? null };
  }
  return {
    ok: false,
    error: {
      code: 'version_mismatch',
      currentHeaderVersion: parsed.data.currentHeaderVersion ?? null,
      currentBodyVersion: parsed.data.currentBodyVersion ?? null,
    },
  };
}

async function resolveRecipientSecretKeyOrSeed(credentials: Credentials): Promise<Uint8Array> {
  requireEncryptionCredentials(credentials);
  if (credentials.encryption.type === 'dataKey') return credentials.encryption.machineKey;
  return await deriveKey(credentials.encryption.secret, 'Happy EnCoder', ['content']);
}

/** Returns null when the envelope is malformed or not sealed to this account. Throws without account key material. */
export async function openArtifactDataEncryptionKey(params: Readonly<{
  credentials: Credentials;
  encryptedDataEncryptionKeyBase64: string;
}>): Promise<Uint8Array | null> {
  const recipientSecretKeyOrSeed = await resolveRecipientSecretKeyOrSeed(params.credentials);
  let envelope: Uint8Array;
  try {
    envelope = decodeBase64(params.encryptedDataEncryptionKeyBase64);
  } catch {
    return null;
  }
  return openEncryptedDataKeyEnvelopeV1({ envelope, recipientSecretKeyOrSeed });
}

export async function sealArtifactDataEncryptionKey(params: Readonly<{
  credentials: Credentials;
  dataEncryptionKey: Uint8Array;
}>): Promise<string> {
  requireEncryptionCredentials(params.credentials);
  const recipientPublicKey = params.credentials.encryption.type === 'dataKey'
    ? params.credentials.encryption.publicKey
    : libsodiumPublicKeyFromSecretKey(await resolveRecipientSecretKeyOrSeed(params.credentials));
  const envelope = sealEncryptedDataKeyEnvelopeV1({
    dataKey: params.dataEncryptionKey,
    recipientPublicKey,
    randomBytes: getRandomBytes,
  });
  return encodeBase64(envelope, 'base64');
}
