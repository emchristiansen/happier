import { join } from 'node:path';

import cliDistBuildManifest from '../../cliDistBuildManifest.cjs';

const EXPECTED_POST_PROJECTION_MANIFEST_FAILURES = new Set([
  'build_manifest_file_count_mismatch',
  'build_manifest_fingerprint_mismatch',
]);

export function refreshCliBinaryArtifactClosureBuildManifest(
  params: Readonly<{ payloadDir: string }>,
): void {
  const entrypoint = join(params.payloadDir, 'package-dist', 'index.mjs');
  const previous = cliDistBuildManifest.readCliDistBuildManifest(entrypoint);
  if (previous.ok) return;
  if (!EXPECTED_POST_PROJECTION_MANIFEST_FAILURES.has(previous.reason) || !previous.manifest) {
    throw new Error(
      `[cli-dist-manifest] cannot refresh projected artifact manifest: ${previous.reason}`,
    );
  }
  const { builtAt, buildVersion, inputFingerprint } = previous.manifest;
  cliDistBuildManifest.writeCliDistBuildManifest(entrypoint, {
    ...(typeof builtAt === 'string' ? { builtAt } : {}),
    ...(typeof buildVersion === 'string' ? { buildVersion } : {}),
    ...(typeof inputFingerprint === 'string' ? { inputFingerprint } : {}),
  });
}

export function recordCliBinaryArtifactRuntimeAssetBuildManifest(
  params: Readonly<{ payloadDir: string; relativePath: string }>,
): void {
  cliDistBuildManifest.writeCliRuntimeAssetBuildManifest({
    runtimeRoot: params.payloadDir,
    entrypoint: join(params.payloadDir, 'package-dist', 'index.mjs'),
    relativePath: params.relativePath,
  });
}

export function refreshCliBinaryArtifactRuntimeAssetBuildManifest(
  params: Readonly<{ payloadDir: string }>,
): void {
  cliDistBuildManifest.refreshCliRuntimeAssetBuildManifest({
    runtimeRoot: params.payloadDir,
    entrypoint: join(params.payloadDir, 'package-dist', 'index.mjs'),
  });
}
