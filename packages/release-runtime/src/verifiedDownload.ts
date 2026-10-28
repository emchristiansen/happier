import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { lookupSha256 } from './checksums.js';
import { requestBytes, requestText, type DownloadProgress } from './http.js';
import { verifyMinisign } from './minisign.js';

type ReleaseAsset = Readonly<{ name: string; url: string }>;

export type ReleaseAssetBundle = Readonly<{
  version: string;
  archive: ReleaseAsset;
  checksums: ReleaseAsset;
  checksumsSig: ReleaseAsset;
}>;

export type VerifiedDownloadProgress = Readonly<{
  phase: 'downloading' | 'verifying';
  receivedBytes?: number;
  totalBytes?: number;
}>;

export class ReleaseVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseVerificationError';
  }
}

function sha256Hex(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function downloadVerifiedReleaseAssetBundle(params: Readonly<{
  bundle: ReleaseAssetBundle;
  destDir: string;
  pubkeyFile: string;
  userAgent?: string;
  signal?: AbortSignal;
  onProgress?: (progress: VerifiedDownloadProgress) => void;
}>): Promise<Readonly<{
  version: string;
  archiveName: string;
  archivePath: string;
  source: { archiveUrl: string; checksumsUrl: string };
}>> {
  const bundle = params.bundle;
  const destDir = String(params.destDir ?? '').trim();
  const pubkeyFile = String(params.pubkeyFile ?? '');
  const userAgent = String(params.userAgent ?? '').trim() || 'happier-release-runtime';
  if (!destDir) throw new Error('[download] destDir is required');
  if (!pubkeyFile.trim()) throw new Error('[download] pubkeyFile is required');

  await mkdir(destDir, { recursive: true });
  const requestOptions = { headers: { 'user-agent': userAgent }, signal: params.signal };
  params.onProgress?.({ phase: 'downloading' });
  const checksumsText = await requestText({ ...requestOptions, url: bundle.checksums.url });
  const sigFile = await requestText({ ...requestOptions, url: bundle.checksumsSig.url });
  params.onProgress?.({ phase: 'verifying' });
  const ok = verifyMinisign({ message: Buffer.from(checksumsText, 'utf-8'), pubkeyFile, sigFile });
  if (!ok) {
    throw new ReleaseVerificationError('[download] signature verification failed for checksums file');
  }

  const expected = lookupSha256({ checksumsText, filename: bundle.archive.name });
  params.onProgress?.({ phase: 'downloading' });
  const bytes = await requestBytes({
    ...requestOptions,
    url: bundle.archive.url,
    onProgress: (progress: DownloadProgress) => params.onProgress?.({ phase: 'downloading', ...progress }),
  });
  params.signal?.throwIfAborted();
  params.onProgress?.({ phase: 'verifying' });
  const actual = sha256Hex(bytes);
  if (actual !== expected) {
    throw new ReleaseVerificationError(`[download] checksum verification failed for ${bundle.archive.name}`);
  }

  const archivePath = join(destDir, bundle.archive.name);
  await writeFile(archivePath, bytes, { signal: params.signal });
  return {
    version: String(bundle.version ?? ''),
    archiveName: bundle.archive.name,
    archivePath,
    source: { archiveUrl: bundle.archive.url, checksumsUrl: bundle.checksums.url },
  };
}
