import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getFirstPartyComponentCatalogEntry } from '../firstPartyRuntime/componentCatalog.js';
import { bundleInstalledPackageWithRuntimeDependencies } from '../workspaces/index.js';
import { finalizeRuntimeArtifactPayload } from './finalizeRuntimeArtifactPayload.js';
import { resolveCliToolsPlatformDir, type BinaryTarget } from './targets.js';

export type CliOptionalComponentId = 'happier-memory-runtime' | 'happier-difftastic';

type ToolArchiveEntry = Readonly<{
  tool: string;
  platformDir: string;
  archiveName: string;
  binaryName: string;
  licenseName?: string;
}>;

type CliToolUnpackModule = Readonly<{
  getToolArchiveManifest: () => readonly ToolArchiveEntry[];
  unpackTools: (options: Readonly<{ platformDir: string; toolsDir: string; tools: readonly string[] }>) => Promise<unknown>;
}>;

export async function buildCliOptionalComponentArtifactPayload(params: Readonly<{
  repoRoot: string;
  payloadDir: string;
  target: BinaryTarget;
  componentId: CliOptionalComponentId;
}>): Promise<void> {
  const { repoRoot, payloadDir, target, componentId } = params;
  await rm(payloadDir, { recursive: true, force: true });
  await mkdir(payloadDir, { recursive: true });

  if (componentId === 'happier-memory-runtime') {
    bundleInstalledPackageWithRuntimeDependencies({
      packageName: '@huggingface/transformers',
      resolveFromPackageJsonPath: join(repoRoot, 'package.json'),
      destNodeModulesDir: join(payloadDir, 'node_modules'),
    });
  } else {
    const scriptPath = join(repoRoot, 'apps', 'cli', 'scripts', 'unpack-tools.cjs');
    const unpacker = createRequire(scriptPath)(scriptPath) as CliToolUnpackModule;
    const platformDir = resolveCliToolsPlatformDir(target);
    const entry = unpacker.getToolArchiveManifest().find((candidate) => candidate.tool === 'difftastic' && candidate.platformDir === platformDir);
    if (!entry?.licenseName) throw new Error(`[component-artifacts] missing difftastic archive/license for ${platformDir}`);
    const scratch = await mkdtemp(join(tmpdir(), 'happier-difftastic-payload-'));
    try {
      const archivesDir = join(scratch, 'archives');
      await mkdir(archivesDir);
      for (const name of [entry.archiveName, entry.licenseName, 'checksums.sha256']) {
        await cp(join(repoRoot, 'apps', 'cli', 'tools', 'archives', name), join(archivesDir, name));
      }
      await unpacker.unpackTools({ toolsDir: scratch, platformDir, tools: ['difftastic'] });
      const component = getFirstPartyComponentCatalogEntry(componentId);
      await cp(join(scratch, 'unpacked', entry.binaryName), join(payloadDir, `${component.binaryRelativePath}${target.exeExt}`));
      await cp(join(scratch, 'unpacked', entry.licenseName), join(payloadDir, entry.licenseName));
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  await finalizeRuntimeArtifactPayload(payloadDir, target);
}
