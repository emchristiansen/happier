// Official pinned Antigravity ACP server (EU-3).
//
// Provenance (2026-09-11):
// - Asset matrix mirrors the concurrent 0.3 `packages/plugins/antigravity/src/manifest.ts`
//   `agy-acp-server` pinnedArchive v1.1.1 (dirty, Not Committed Yet) as the best available
//   registry-derived source.
// - All five archive URLs verified live via primary `dl.google.com` HEAD 200 on 2026-09-11
//   (darwin-arm64 316,014,828 bytes; linux-x86_64 681,969,407 bytes;
//   linux-arm64 656,572,786 bytes; windows-x86_64 468,238,392 bytes;
//   windows-arm64 468,521,191 bytes).
// - SHA-256 values are encoded from that same 0.3 source; the installer verifies the digest
//   on every download via `downloadGitHubReleaseAsset`, so a wrong pin fails closed at
//   install time instead of launching an untrusted binary.
// - Linux `--uid=` launch args and `.par`/`.exe` executable subpaths come from the same
//   0.3 source; 0.2 has no `hstack-exec` launcher (`apps/stack/bin/hstack-exec` absent,
//   recorded) so heavy full-archive SHA re-downloads use the nearest repo-owned path.
//
// Unsupported platforms (notably darwin-x64, for which Google publishes no v1.1.1 archive)
// fail clearly instead of being emulated.

import type { ArchiveExtractionLimits } from '@happier-dev/release-runtime/archiveExtraction';
import { AGY_ACP_SERVER_VERSION } from '@happier-dev/protocol/installables';

// The pinned v1.1.1 Linux x64 ZIP is 681,969,407 bytes and expands to
// 2,009,327,248 bytes, including a 1,880,360,328-byte agy_acp_server.par.
// It is the largest of the five pinned payloads. Keep these bounds local to
// this checksum-verified release instead of relaxing generic archive limits.
// Expansion of this 2 GB payload can exceed the generic two-minute timeout.
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
    archiveUrl: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_1.1.1-darwin-arm64.zip',
    sha256: 'fdfa915652cdb7ba8085cc8fffed072cbe009251aa2c951aabdda07a8c28a189',
    executableSubpath: 'agy_acp_server.par',
  },
  'linux-x64': {
    archiveUrl: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-x86_64.zip',
    sha256: '38f62d01b32deb0907b3d39a71ec301fd36369f6ffd1cf262d4af385177f79df',
    executableSubpath: 'agy_acp_server.par',
    args: ['--uid='],
  },
  'linux-arm64': {
    archiveUrl: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-arm64.zip',
    sha256: 'ed69e64b308fcb123ab54bf3277bf9cb0d651064f885ea5aab0ff520c7175398',
    executableSubpath: 'agy_acp_server.par',
    args: ['--uid='],
  },
  'win32-x64': {
    archiveUrl: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-x86_64.zip',
    sha256: '47cb50eef14f0a4655d78cfcfda869bcea7aaee5f9787e936bc2935ea612c3b8',
    executableSubpath: 'agy_acp_server.exe',
  },
  'win32-arm64': {
    archiveUrl: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-arm64.zip',
    sha256: '35f4b1f47ba6a3fea7b0a3e30010df5ea73a64b4f0e7cf991cddc673ddfbcafc',
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
