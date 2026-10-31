import { getRandomBytes } from '@/platform/cryptoRandom';
import { digest } from '@/platform/digest';
import { encodeBase64 } from '@/encryption/base64';
import { parseOauthAuthorizationResponse } from '@happier-dev/protocol';

export type PkceCodes = Readonly<{
  verifier: string;
  challenge: string;
}>;

function clampPkceVerifierBytes(bytes: number): number {
  const n = Number.isFinite(bytes) ? Math.floor(bytes) : 32;
  return Math.min(96, Math.max(32, n));
}

export async function generatePkceCodes(bytes: number = 32): Promise<PkceCodes> {
  const verifier = encodeBase64(getRandomBytes(clampPkceVerifierBytes(bytes)), 'base64url');
  const challengeBytes = await digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = encodeBase64(challengeBytes, 'base64url');
  return { verifier, challenge };
}

export function generateOauthState(bytes: number = 32): string {
  return encodeBase64(getRandomBytes(bytes), 'base64url');
}

export function parseOauthCallbackUrl(params: Readonly<{ url: string; redirectUri: string; allowRawAuthorizationCode?: boolean }>): Readonly<{
  code?: string;
  state?: string;
  error?: string;
  rawAuthorizationCode?: true;
}> {
  const response = parseOauthAuthorizationResponse({ input: params.url, redirectUri: params.redirectUri, allowRawAuthorizationCode: params.allowRawAuthorizationCode });
  if (response.kind === 'invalid') return {};
  if (response.kind === 'rawAuthorizationCode') return { code: response.code, rawAuthorizationCode: true };
  const { kind: _kind, ...callback } = response;
  return callback;
}
