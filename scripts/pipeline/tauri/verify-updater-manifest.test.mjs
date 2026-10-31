import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readUpdaterPublicKey, verifyUpdaterManifestSignatures } from './verify-updater-manifest.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Boundary stand-in for `minisign -V`: a "signature" here is the artifact's sha256 bound to the key.
const fakeSign = (bytes, key) => Buffer.from(`${key}:${createHash('sha256').update(bytes).digest('hex')}`).toString('base64');
const fakeVerify = ({ artifactPath, signatureFile, publicKey }) => {
  const expected = `${publicKey}:${createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex')}`;
  if (fs.readFileSync(signatureFile, 'utf8') !== expected) {
    throw Object.assign(new Error('verify failed'), { stderr: 'Signature verification failed' });
  }
};

function fixture(tamper) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-manifest-test-'));
  const artifactsDir = path.join(root, 'updates');
  const files = {
    'linux-x86_64': path.join(artifactsDir, 'linux-x86_64', 'happier-ui-desktop-linux-x86_64-v1.0.0.AppImage'),
    'darwin-aarch64': path.join(artifactsDir, 'happier-ui-desktop-darwin-aarch64-v1.0.0.app.tar.gz'),
  };
  const platforms = {};
  for (const [platform, file] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `bytes-${platform}`);
    platforms[platform] = {
      url: `https://github.com/o/r/releases/download/ui-desktop-v1.0.0/${path.basename(file)}`,
      signature: fakeSign(Buffer.from(`bytes-${platform}`), 'RWKEY'),
    };
  }
  tamper?.({ files, platforms });
  const latestJsonPath = path.join(root, 'latest.json');
  fs.writeFileSync(latestJsonPath, JSON.stringify({ version: '1.0.0', platforms }));
  return { root, artifactsDir, latestJsonPath };
}

test('every latest.json platform entry is verified against the artifact its url names', () => {
  const { root, artifactsDir, latestJsonPath } = fixture();
  try {
    assert.deepEqual(verifyUpdaterManifestSignatures({ latestJsonPath, artifactsDir, publicKey: 'RWKEY', verify: fakeVerify }), [
      { platform: 'linux-x86_64', artifact: 'happier-ui-desktop-linux-x86_64-v1.0.0.AppImage' },
      { platform: 'darwin-aarch64', artifact: 'happier-ui-desktop-darwin-aarch64-v1.0.0.app.tar.gz' },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an artifact changed after signing, or a signature from another key, names the rejected platform', () => {
  const tampered = fixture(({ files }) => fs.writeFileSync(files['darwin-aarch64'], 'rebuilt'));
  try {
    assert.throws(
      () => verifyUpdaterManifestSignatures({ ...tampered, publicKey: 'RWKEY', verify: fakeVerify }),
      /darwin-aarch64: the updater would reject happier-ui-desktop-darwin-aarch64-v1\.0\.0\.app\.tar\.gz.*Signature verification failed/,
    );
    assert.throws(() => verifyUpdaterManifestSignatures({ ...tampered, publicKey: 'RWOTHER', verify: fakeVerify }), /linux-x86_64: the updater would reject/);
  } finally {
    fs.rmSync(tampered.root, { recursive: true, force: true });
  }
});

test('the updater key is read from the config each environment is built with', () => {
  const tauriDir = path.join(repoRoot, 'apps', 'ui', 'src-tauri');
  for (const environment of ['production', 'preview', 'publicdev']) {
    assert.match(readUpdaterPublicKey({ tauriDir, environment }), /^RW[A-Za-z0-9+/=]{50,}$/u);
  }
});
