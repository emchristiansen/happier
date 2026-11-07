import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';

function b64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function base64UrlToBuffer(value) {
  const encoded = String(value ?? '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(String(value ?? '').length / 4) * 4, '=');
  return Buffer.from(encoded, 'base64');
}

export function createMinisignKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const rawPublicKey = base64UrlToBuffer(jwk.x);
  assert.equal(rawPublicKey.length, 32);

  const keyId = Buffer.from('0123456789abcdef', 'hex');
  const publicKeyBytes = Buffer.concat([Buffer.from('Ed'), keyId, rawPublicKey]);
  const pubkeyFile = `untrusted comment: minisign public key\n${b64(publicKeyBytes)}\n`;
  return { pubkeyFile, keyId, privateKey };
}

export function signMinisignMessage({ message, keyId, privateKey }) {
  const signature = sign(null, message, privateKey);
  const sigLineBytes = Buffer.concat([Buffer.from('Ed'), keyId, signature]);
  const trustedComment = 'trusted comment: test';
  const trustedSuffix = Buffer.from(trustedComment.slice('trusted comment: '.length), 'utf-8');
  const globalSignature = sign(null, Buffer.concat([signature, trustedSuffix]), privateKey);
  return [
    'untrusted comment: signature from happier test',
    b64(sigLineBytes),
    trustedComment,
    b64(globalSignature),
    '',
  ].join('\n');
}
