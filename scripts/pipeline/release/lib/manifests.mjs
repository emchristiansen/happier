import { listPublicReleaseChannels } from './public-release-rings.mjs';
import { BINARY_PUBLISH_PRODUCT_IDS, CLI_OPTIONAL_COMPONENT_PRODUCTS, getBinaryPublishProductSpec } from '../publishing/product-specs.mjs';

export const MANIFEST_SCHEMA_VERSION = 'v1';

const PRODUCT_NAMES = new Set(['happier', 'hstack', 'happier-server']);
const ARTIFACT_FILENAME = new RegExp(`^(${[...PRODUCT_NAMES, ...CLI_OPTIONAL_COMPONENT_PRODUCTS].join('|')})-v(.+)-([a-z]+)-(x64|arm64)\\.tar\\.gz$`);
const RELEASE_METADATA_FILENAMES = new Set(BINARY_PUBLISH_PRODUCT_IDS.flatMap((product) => {
  const spec = getBinaryPublishProductSpec(product);
  const evidenceSuffixes = [spec.notarizationEvidenceSuffix, ...(spec.optionalComponentProducts ?? [])];
  return [
    'latest.json',
    ...spec.artifactTargets.map(({ os, arch }) => `${os}-${arch}.json`),
    ...spec.artifactTargets.filter(({ os }) => os === 'darwin').flatMap(({ os, arch }) => (
      evidenceSuffixes.map((suffix) => `${os}-${arch}.${suffix}.json`)
    )),
  ];
}));
const RELEASE_CHANNELS = new Set(
  listPublicReleaseChannels()
    .map((entry) => entry.manifestChannel)
    .filter((channel) => typeof channel === 'string' && channel.length > 0)
);

// @ts-check

export function parseArtifactFilename(name) {
  const raw = String(name ?? '').trim();
  const match = ARTIFACT_FILENAME.exec(raw);
  if (!match) return null;
  const [, product, version, os, arch] = match;
  return { product, version, os, arch, filename: raw };
}

export function isBinaryReleaseArtifactFilename(name) {
  // Checksum envelopes/signatures and unrelated control metadata are not payload artifacts.
  return parseArtifactFilename(name) !== null || RELEASE_METADATA_FILENAMES.has(name);
}

export function assertValidProduct(product) {
  const value = String(product ?? '').trim();
  if (!PRODUCT_NAMES.has(value)) {
    throw new Error(`[release] invalid product "${value}" (expected happier|hstack|happier-server)`);
  }
  return value;
}

export function buildManifestRecord(params) {
  const product = assertValidProduct(params.product);
  const channel = String(params.channel ?? '').trim();
  if (!RELEASE_CHANNELS.has(channel)) {
    throw new Error(`[release] invalid channel "${channel}"`);
  }
  const version = String(params.version ?? '').trim();
  const os = String(params.os ?? '').trim();
  const arch = String(params.arch ?? '').trim();
  const url = String(params.url ?? '').trim();
  const sha256 = String(params.sha256 ?? '').trim();
  if (!version || !os || !arch || !url || !sha256) {
    throw new Error('[release] manifest record requires version/os/arch/url/sha256');
  }
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    product,
    channel,
    version,
    os,
    arch,
    url,
    sha256,
    signature: params.signature ?? null,
    publishedAt: params.publishedAt ?? new Date().toISOString(),
    minSupportedVersion: params.minSupportedVersion ?? null,
    rolloutPercent: Number(params.rolloutPercent ?? 100),
    critical: Boolean(params.critical ?? false),
    notesUrl: params.notesUrl ?? null,
    build: {
      commitSha: params.commitSha ?? null,
      workflowRunId: params.workflowRunId ?? null,
    },
  };
}
