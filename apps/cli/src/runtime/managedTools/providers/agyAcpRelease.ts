// Official ACP registry 1.3.0 assets (reviewed 2026-10-08).
// SHA-256 values were calculated from each complete dl.google.com archive;
// each ZIP contains the flat server + companion localharness payload.
// Native execution still requires the matching platform and architecture.

import type { ArchiveExtractionLimits } from '@happier-dev/release-runtime/archiveExtraction';
import { AGY_ACP_SERVER_VERSION } from '@happier-dev/protocol/installables';

// Reviewed 1.3.0 maxima: 333,727,150 archive bytes, 930,848,992 bytes
// per file and 1,056,922,005 expanded bytes. Retain the existing release-owned
// extraction budget, including the deadline for large executable extraction.
const ARCHIVE_EXTRACTION_LIMITS = Object.freeze({
  maxArchiveBytes: 1024 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024 * 1024,
  maxExpandedBytes: 2 * 1024 * 1024 * 1024,
  timeoutMs: 10 * 60_000,
});

export type AgyAcpReleaseAsset = Readonly<{
  name: string;
  url: string;
  sha256: string;
  tag: string | null;
  version: string | null;
  executableSubpath: string;
  args: readonly string[];
  archiveExtractionLimits: Pick<
    ArchiveExtractionLimits,
    'maxArchiveBytes' | 'maxFileBytes' | 'maxExpandedBytes' | 'timeoutMs'
  >;
}>;

type PinnedAsset = Readonly<{
  archiveUrl: string;
  sha256: string;
  executableSubpath: string;
  args?: readonly string[];
}>;

const PINNED_ASSETS: Readonly<Record<string, PinnedAsset>> = Object.freeze({
  'darwin-arm64': {
    archiveUrl: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-arm64.zip',
    sha256: '7cd97045f7b4fe81175a107cdf16f9c51484e3c78a5162cae415338bb6aa5b88',
    executableSubpath: 'agy_acp_server.par',
  },
  'darwin-x64': {
    archiveUrl: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-x86_64.zip',
    sha256: 'bb23956b89984bf5d354af2c3725e6c57f0cc1b7228e77a0e91c9c2bc1d47646',
    executableSubpath: 'agy_acp_server.par',
  },
  'linux-x64': {
    archiveUrl: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.3.0-linux-x86_64.zip',
    sha256: '9fb60956af0a9d76220a4db91ca9ac88e2a2372ad68f985ab5fceace6b825b96',
    executableSubpath: 'agy_acp_server.par',
    args: ['--uid='],
  },
  'linux-arm64': {
    archiveUrl: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.3.0-linux-arm64.zip',
    sha256: '500b0bc0fb858e88f4df404d4cedf80bf9298c178291e39e383d6c50b111cbdf',
    executableSubpath: 'agy_acp_server.par',
    args: ['--uid='],
  },
  'win32-x64': {
    archiveUrl: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.3.0-windows-x86_64.zip',
    sha256: '65215e0688681fa3116e048a9eab27ef53af1bbd6f3da3f1c52bd4911d8b17f9',
    executableSubpath: 'agy_acp_server.exe',
  },
  'win32-arm64': {
    archiveUrl: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.3.0-windows-arm64.zip',
    sha256: '4a0f469720e9beb9438a979f543fdbfad5022ebe0992c052c590bd78b3144ca3',
    executableSubpath: 'agy_acp_server.exe',
  },
});

function normalizePlatform(platform: string): string {
  return String(platform ?? '').trim();
}

function normalizeArch(arch: string): string {
  const value = String(arch ?? '').trim();
  if (value === 'x86_64') return 'x64';
  if (value === 'aarch64') return 'arm64';
  return value;
}

function resolvePlatformKey(platform: string, arch: string): string | null {
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedArch = normalizeArch(arch);
  if (normalizedPlatform === 'darwin' && normalizedArch === 'arm64') return 'darwin-arm64';
  if (normalizedPlatform === 'darwin' && normalizedArch === 'x64') return 'darwin-x64';
  if (normalizedPlatform === 'linux' && normalizedArch === 'x64') return 'linux-x64';
  if (normalizedPlatform === 'linux' && normalizedArch === 'arm64') return 'linux-arm64';
  if (normalizedPlatform === 'win32' && normalizedArch === 'x64') return 'win32-x64';
  if (normalizedPlatform === 'win32' && normalizedArch === 'arm64') return 'win32-arm64';
  return null;
}

function basenameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? 'agy-acp-server.zip';
  } catch {
    return 'agy-acp-server.zip';
  }
}

export function resolveAgyAcpReleaseAsset(
  opts: Readonly<{ platform?: string; arch?: string }> = {},
): AgyAcpReleaseAsset {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const key = resolvePlatformKey(platform, arch);
  const pinned = key ? PINNED_ASSETS[key] : undefined;
  if (!key || !pinned) {
    throw new Error(`Unsupported agy-acp-server platform: ${platform}/${arch}`);
  }
  return {
    name: basenameFromUrl(pinned.archiveUrl),
    url: pinned.archiveUrl,
    sha256: pinned.sha256,
    tag: AGY_ACP_SERVER_VERSION,
    version: AGY_ACP_SERVER_VERSION,
    executableSubpath: pinned.executableSubpath,
    args: pinned.args ?? [],
    archiveExtractionLimits: ARCHIVE_EXTRACTION_LIMITS,
  };
}
