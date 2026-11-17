import {
  PromptDocArtifactHeaderV1Schema,
  PromptDocBodyV1Schema,
  type PromptDocArtifactHeaderV1,
  type PromptDocBodyV1,
} from '@happier-dev/protocol';

import {
  fetchArtifactRecord,
  openArtifactDataEncryptionKey,
  updateArtifactRecord,
  type ArtifactRequestError,
} from '@/api/artifacts/artifactRecords';
import { decodeBase64, decryptWithDataKey, encodeBase64, encryptWithDataKey } from '@/api/encryption';
import { checkArtifactBodyPrecondition, digestArtifactBody } from '@/agent/promptLibrary/artifactBodyDigest';
import type { Credentials } from '@/persistence';

export type PromptDocArtifact = Readonly<{
  artifactId: string;
  header: PromptDocArtifactHeaderV1;
  headerVersion: number;
  bodyVersion: number;
  /** SHA-256 (lowercase hex) of the exact UTF-8 bytes of the decrypted body string, taken before it is parsed. */
  bodySha256: string;
  bodyBytes: number;
  seq: number;
  createdAt: number;
  updatedAt: number;
  doc: PromptDocBodyV1;
}>;

export type PromptDocReadError =
  | ArtifactRequestError
  | Readonly<{ code: 'encryption_key_required' }>
  | Readonly<{ code: 'data_key_unavailable' }>
  | Readonly<{ code: 'header_decrypt_failed' }>
  | Readonly<{ code: 'header_invalid' }>
  | Readonly<{ code: 'body_decrypt_failed' }>
  | Readonly<{ code: 'body_invalid' }>;

export type PromptDocReadResult =
  | Readonly<{ ok: true; artifact: PromptDocArtifact }>
  | Readonly<{ ok: false; error: PromptDocReadError }>;

export type PromptDocUpdateError =
  | PromptDocReadError
  | Readonly<{ code: 'invalid_expected_body_sha256' }>
  | Readonly<{ code: 'version_mismatch'; expectedBodyVersion: number; currentBodyVersion: number | null }>
  | Readonly<{ code: 'body_sha256_mismatch'; bodyVersion: number; expectedBodySha256: string; currentBodySha256: string }>;

export type PromptDocUpdateResult =
  | Readonly<{
      ok: true;
      artifactId: string;
      previousBodyVersion: number;
      previousBodySha256: string;
      bodyVersion: number;
      bodySha256: string;
      bodyBytes: number;
    }>
  | Readonly<{ ok: false; error: PromptDocUpdateError }>;

type OpenedPromptDoc = Readonly<{
  artifact: PromptDocArtifact;
  dataEncryptionKey: Uint8Array;
  /** The decrypted body plaintext; an update keeps every field except the serialized document. */
  bodyPlaintext: Readonly<Record<string, unknown>>;
  /** The exact decrypted body string the digest covers. */
  bodyText: string;
}>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function openPromptDoc(params: Readonly<{
  credentials: Credentials;
  artifactId: string;
}>): Promise<Readonly<{ ok: true; opened: OpenedPromptDoc }> | Readonly<{ ok: false; error: PromptDocReadError }>> {
  if (!params.credentials.encryption) return { ok: false, error: { code: 'encryption_key_required' } };

  const fetched = await fetchArtifactRecord(params);
  if (!fetched.ok) return fetched;
  const { record } = fetched;

  const dataEncryptionKey = await openArtifactDataEncryptionKey({
    credentials: params.credentials,
    encryptedDataEncryptionKeyBase64: record.dataEncryptionKey,
  });
  if (!dataEncryptionKey) return { ok: false, error: { code: 'data_key_unavailable' } };

  const headerPlaintext: unknown = decryptWithDataKey(decodeBase64(record.header), dataEncryptionKey);
  if (headerPlaintext === null) return { ok: false, error: { code: 'header_decrypt_failed' } };
  const header = PromptDocArtifactHeaderV1Schema.safeParse(headerPlaintext);
  if (!header.success) return { ok: false, error: { code: 'header_invalid' } };

  const bodyPlaintext: unknown = decryptWithDataKey(decodeBase64(record.body), dataEncryptionKey);
  if (bodyPlaintext === null) return { ok: false, error: { code: 'body_decrypt_failed' } };
  if (!isPlainObject(bodyPlaintext) || typeof bodyPlaintext.body !== 'string') {
    return { ok: false, error: { code: 'body_invalid' } };
  }
  const bodyText = bodyPlaintext.body;
  const { bodySha256, bodyBytes } = digestArtifactBody(bodyText);
  let docJson: unknown;
  try {
    docJson = JSON.parse(bodyText);
  } catch {
    return { ok: false, error: { code: 'body_invalid' } };
  }
  const doc = PromptDocBodyV1Schema.safeParse(docJson);
  if (!doc.success) return { ok: false, error: { code: 'body_invalid' } };

  return {
    ok: true,
    opened: {
      artifact: {
        artifactId: record.id,
        header: header.data,
        headerVersion: record.headerVersion,
        bodyVersion: record.bodyVersion,
        bodySha256,
        bodyBytes,
        seq: record.seq,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        doc: doc.data,
      },
      dataEncryptionKey,
      bodyPlaintext,
      bodyText,
    },
  };
}

/** Reads one prompt document by id: exactly `GET /v1/artifacts/:id`, with the stored markdown unmodified. */
export async function readPromptDocArtifact(params: Readonly<{
  credentials: Credentials;
  artifactId: string;
}>): Promise<PromptDocReadResult> {
  const opened = await openPromptDoc(params);
  return opened.ok ? { ok: true, artifact: opened.opened.artifact } : opened;
}

/**
 * Replaces one prompt document's markdown, only if its body is still at `expectedBodyVersion` and its exact
 * decrypted body string still has digest `expectedBodySha256`. The current record is read first; a different
 * version or body fails without writing, and the write itself carries `expectedBodyVersion` so the server
 * rejects a change that lands in between. The header, the data key, `createdAtMs` and every other body field
 * are kept; `updatedAtMs` is set to `nowMs`.
 */
export async function updatePromptDocMarkdown(params: Readonly<{
  credentials: Credentials;
  artifactId: string;
  expectedBodyVersion: number;
  expectedBodySha256: string;
  markdown: string;
  nowMs: number;
}>): Promise<PromptDocUpdateResult> {
  const opened = await openPromptDoc(params);
  if (!opened.ok) return opened;
  const { artifact, dataEncryptionKey, bodyPlaintext, bodyText } = opened.opened;

  const precondition = checkArtifactBodyPrecondition(
    { bodyVersion: artifact.bodyVersion, body: bodyText },
    { expectedBodyVersion: params.expectedBodyVersion, expectedBodySha256: params.expectedBodySha256 },
  );
  if (!precondition.ok) {
    const { ok: _ok, ...error } = precondition;
    return { ok: false, error };
  }

  const nextDoc: PromptDocBodyV1 = PromptDocBodyV1Schema.parse({
    ...artifact.doc,
    markdown: params.markdown,
    updatedAtMs: params.nowMs,
  });
  const nextBodyText = JSON.stringify(nextDoc);
  const body = encodeBase64(encryptWithDataKey({ ...bodyPlaintext, body: nextBodyText }, dataEncryptionKey), 'base64');

  const updated = await updateArtifactRecord({
    credentials: params.credentials,
    artifactId: params.artifactId,
    request: { body, expectedBodyVersion: params.expectedBodyVersion },
  });
  if (!updated.ok) {
    const { error } = updated;
    if (error.code === 'version_mismatch') {
      return {
        ok: false,
        error: { code: 'version_mismatch', expectedBodyVersion: params.expectedBodyVersion, currentBodyVersion: error.currentBodyVersion },
      };
    }
    return { ok: false, error };
  }
  if (updated.bodyVersion === null) {
    return { ok: false, error: { code: 'invalid_response', message: 'artifact update succeeded without a body version' } };
  }
  const next = digestArtifactBody(nextBodyText);
  return {
    ok: true,
    artifactId: params.artifactId,
    previousBodyVersion: params.expectedBodyVersion,
    previousBodySha256: artifact.bodySha256,
    bodyVersion: updated.bodyVersion,
    bodySha256: next.bodySha256,
    bodyBytes: next.bodyBytes,
  };
}
