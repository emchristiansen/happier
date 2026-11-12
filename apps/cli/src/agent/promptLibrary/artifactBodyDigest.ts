import { createHash } from 'node:crypto';

export type ArtifactBodyDigest = Readonly<{
  /** Lowercase hex SHA-256 of the exact UTF-8 bytes of the decrypted body string. */
  bodySha256: string;
  bodyBytes: number;
}>;

/**
 * Digests the decrypted artifact body exactly as stored: the plaintext `body` string inside the
 * decrypted envelope, before any JSON parsing or re-serialization.
 */
export function digestArtifactBody(body: string): ArtifactBodyDigest {
  const bytes = Buffer.from(body, 'utf8');
  return {
    bodySha256: createHash('sha256').update(bytes).digest('hex'),
    bodyBytes: bytes.byteLength,
  };
}

export type ArtifactBodyPrecondition = Readonly<{
  expectedBodyVersion: number;
  expectedBodySha256: string;
}>;

export type ArtifactBodyPreconditionResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; code: 'invalid_expected_body_sha256' }>
  | Readonly<{ ok: false; code: 'version_mismatch'; expectedBodyVersion: number; currentBodyVersion: number }>
  | Readonly<{
      ok: false;
      code: 'body_sha256_mismatch';
      bodyVersion: number;
      expectedBodySha256: string;
      currentBodySha256: string;
    }>;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Whether `value` is a digest in the form `digestArtifactBody` produces: 64 lowercase hex characters. */
export function isArtifactBodySha256(value: string): boolean {
  return SHA256_HEX.test(value);
}

/**
 * Checks a freshly read body against the caller's expected version and exact-body digest. It runs
 * before the write; the write must still carry `expectedBodyVersion` so the server rejects a change
 * that lands in between. A body version names one immutable body, so the pair binds both.
 */
export function checkArtifactBodyPrecondition(
  current: Readonly<{ bodyVersion: number; body: string }>,
  expected: ArtifactBodyPrecondition,
): ArtifactBodyPreconditionResult {
  if (!isArtifactBodySha256(expected.expectedBodySha256)) {
    return { ok: false, code: 'invalid_expected_body_sha256' };
  }
  if (current.bodyVersion !== expected.expectedBodyVersion) {
    return {
      ok: false,
      code: 'version_mismatch',
      expectedBodyVersion: expected.expectedBodyVersion,
      currentBodyVersion: current.bodyVersion,
    };
  }
  const { bodySha256 } = digestArtifactBody(current.body);
  if (bodySha256 !== expected.expectedBodySha256) {
    return {
      ok: false,
      code: 'body_sha256_mismatch',
      bodyVersion: current.bodyVersion,
      expectedBodySha256: expected.expectedBodySha256,
      currentBodySha256: bodySha256,
    };
  }
  return { ok: true };
}
