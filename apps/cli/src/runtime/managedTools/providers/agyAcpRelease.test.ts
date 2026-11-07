import { describe, expect, it } from 'vitest';

import { resolveAgyAcpReleaseAsset } from './agyAcpRelease.js';

// Official registry URLs; archive-byte SHA-256 and ZIP directory sizes reviewed
// on 2026-10-08 against all six Google 1.3.0 downloads.
const officialAssets = [
  ['darwin', 'arm64', 'macos', 'darwin-arm64', '7cd97045f7b4fe81175a107cdf16f9c51484e3c78a5162cae415338bb6aa5b88', 111_456_962, 278_535_456, 397_146_848],
  ['darwin', 'x64', 'macos', 'darwin-x86_64', 'bb23956b89984bf5d354af2c3725e6c57f0cc1b7228e77a0e91c9c2bc1d47646', 117_245_544, 282_840_688, 407_016_080],
  ['linux', 'x64', 'linux', 'linux-x86_64', '9fb60956af0a9d76220a4db91ca9ac88e2a2372ad68f985ab5fceace6b825b96', 333_727_150, 926_533_965, 1_056_922_005],
  ['linux', 'arm64', 'linux', 'linux-arm64', '500b0bc0fb858e88f4df404d4cedf80bf9298c178291e39e383d6c50b111cbdf', 321_690_363, 930_848_992, 1_054_073_960],
  ['win32', 'x64', 'windows', 'windows-x86_64', '65215e0688681fa3116e048a9eab27ef53af1bbd6f3da3f1c52bd4911d8b17f9', 124_509_787, 145_548_952, 226_986_288],
  ['win32', 'arm64', 'windows', 'windows-arm64', '4a0f469720e9beb9438a979f543fdbfad5022ebe0992c052c590bd78b3144ca3', 124_654_803, 135_640_216, 221_533_688],
] as const;

describe('agy_acp_server pinned release', () => {
  it.each(officialAssets)('resolves the reviewed 1.3.0 %s/%s archive within its extraction budget', (platform, arch, directory, target, sha256, archiveBytes, maxFileBytes, expandedBytes) => {
    const asset = resolveAgyAcpReleaseAsset({ platform, arch });
    expect(asset).toMatchObject({
      version: '1.3.0',
      url: `https://dl.google.com/agy-extensions/releases/${directory}/agy-acp-server-1.3.0-${target}.zip`,
      sha256,
      executableSubpath: platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par',
      args: platform === 'linux' ? ['--uid='] : [],
    });
    expect(asset.archiveExtractionLimits.maxArchiveBytes).toBeGreaterThanOrEqual(archiveBytes);
    expect(asset.archiveExtractionLimits.maxFileBytes).toBeGreaterThanOrEqual(maxFileBytes);
    expect(asset.archiveExtractionLimits.maxExpandedBytes).toBeGreaterThanOrEqual(expandedBytes);
  });

  it('fails clearly on unsupported platforms instead of emulating', () => {
    expect(() => resolveAgyAcpReleaseAsset({ platform: 'freebsd', arch: 'x64' })).toThrow(/unsupported/i);
  });
});
