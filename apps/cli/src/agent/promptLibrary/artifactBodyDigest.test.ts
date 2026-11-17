import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { checkArtifactBodyPrecondition, digestArtifactBody } from './artifactBodyDigest';

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('digestArtifactBody', () => {
  it('hashes the exact UTF-8 bytes, keeping BOM, CRLF and outer whitespace', () => {
    const body = '\uFEFF  {"markdown":"a\\r\\nb é"}\r\n ';
    const bytes = new TextEncoder().encode(body);
    expect(digestArtifactBody(body)).toEqual({ bodySha256: sha(bytes), bodyBytes: bytes.byteLength });
    expect(digestArtifactBody(body).bodySha256).not.toBe(digestArtifactBody(body.trim()).bodySha256);
  });
});

describe('checkArtifactBodyPrecondition', () => {
  const body = '{"v":1,"markdown":"x"}';
  const bodySha256 = sha(new TextEncoder().encode(body));

  it('accepts the matching version and digest', () => {
    expect(checkArtifactBodyPrecondition({ bodyVersion: 3, body }, { expectedBodyVersion: 3, expectedBodySha256: bodySha256 }))
      .toEqual({ ok: true });
  });

  it('refuses a different version before comparing content', () => {
    expect(checkArtifactBodyPrecondition({ bodyVersion: 4, body }, { expectedBodyVersion: 3, expectedBodySha256: bodySha256 }))
      .toEqual({ ok: false, code: 'version_mismatch', expectedBodyVersion: 3, currentBodyVersion: 4 });
  });

  it('refuses a different body at the expected version', () => {
    const result = checkArtifactBodyPrecondition(
      { bodyVersion: 3, body: `${body} ` },
      { expectedBodyVersion: 3, expectedBodySha256: bodySha256 },
    );
    expect(result).toMatchObject({ ok: false, code: 'body_sha256_mismatch', expectedBodySha256: bodySha256 });
  });

  it('refuses a malformed or uppercase expected digest', () => {
    for (const expectedBodySha256 of ['', 'abc', bodySha256.toUpperCase(), `${bodySha256}0`]) {
      expect(checkArtifactBodyPrecondition({ bodyVersion: 3, body }, { expectedBodyVersion: 3, expectedBodySha256 }))
        .toEqual({ ok: false, code: 'invalid_expected_body_sha256' });
    }
  });
});
