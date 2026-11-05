import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { beforeAll, describe, expect, it } from 'vitest';
import { projectPath } from '@/projectPath';
import { ensureBuildArtifactsReadyOnce } from '@/testSetupBuildCoordinator';

function matchesDynamicSpawnHooksImport(text: string): boolean {
  // When daemon spawn hooks are lazily loaded via dynamic import/require, the built output
  // references a chunk like `spawnHooks-<hash>.mjs` at runtime. If the dist folder is
  // rebuilt/cleaned while a daemon is running (common during local dev), those runtime
  // imports can fail and break session spawning.
  //
  // We intentionally assert that `getDaemonSpawnHooks` is not implemented as a lazy
  // dynamic import in the built output.
  const patterns: RegExp[] = [
    /getDaemonSpawnHooks:\s*async\s*\(\)\s*=>\s*\(await\s+import\(\s*['"]\.\/spawnHooks-[^'"]+['"]\s*\)\)/,
    /getDaemonSpawnHooks:\s*async\s*\(\)\s*=>\s*\(await\s+Promise\.resolve\(\)\.then\([^)]*require\(\s*['"]\.\/spawnHooks-[^'"]+['"]\s*\)/,
  ];

  return patterns.some((p) => p.test(text));
}

function matchesDynamicVendorResumeSupportImport(text: string): boolean {
  // The daemon uses vendor-resume support to validate `--resume` and inactive-session resume.
  // When it is implemented as a lazy dynamic import, the built output references a
  // `vendorResumeSupport-<hash>.mjs` chunk at runtime. If the CLI dist folder is rebuilt
  // while a daemon is running, those imports can fail and break resume/spawn flows.
  const patterns: RegExp[] = [
    /getVendorResumeSupport:\s*async\s*\(\)\s*=>\s*\(await\s+import\(\s*['"]\.\/vendorResumeSupport-[^'"]+['"]\s*\)\)\.supportsCodexVendorResume/,
    /getVendorResumeSupport:\s*async\s*\(\)\s*=>\s*\(await\s+Promise\.resolve\(\)\.then\([^)]*require\(\s*['"]\.\/vendorResumeSupport-[^'"]+['"]\s*\)/,
  ];

  return patterns.some((p) => p.test(text));
}

function matchesDynamicConnectedServiceCatalogHookImport(text: string): boolean {
  // These connected-service catalog hooks are used during daemon auth-switch/restart/recovery.
  // If they compile to lazy hashed chunks, a local dev rebuild can remove those chunks while
  // an older daemon is still alive. This guard covers local dev rebuild reliability; installed
  // production runtimes use versioned payloads unless future evidence proves otherwise.
  const patterns: RegExp[] = [
    /getConnectedServiceMaterializer:\s*async\s*\([^)]*\)\s*=>[\s\S]{0,240}(?:import|require)\(\s*['"]\.\/create[A-Z][A-Za-z]+ConnectedServices?Materializer-[^'"]+['"]\s*\)/,
    /getConnectedServiceRuntimeAuthAdapter:\s*async\s*\([^)]*\)\s*=>[\s\S]{0,240}(?:import|require)\(\s*['"]\.\/create[A-Z][A-Za-z]+ConnectedServiceRuntimeAuthAdapter-[^'"]+['"]\s*\)/,
    /getConnectedServiceStateSharingDescriptor:\s*async\s*\([^)]*\)\s*=>[\s\S]{0,240}(?:import|require)\(\s*['"]\.\/[A-Za-z]+ConnectedServiceStateSharingDescriptor-[^'"]+['"]\s*\)/,
    /resolveConnectedServiceSwitchContinuity:\s*async\s*\([^)]*\)\s*=>[\s\S]{0,260}(?:import|require)\(\s*['"]\.\/resolve[A-Z][A-Za-z]+ConnectedServiceSwitchContinuity-[^'"]+['"]\s*\)/,
  ];

  return patterns.some((p) => p.test(text));
}

function matchesDynamicSessionControlAdapterImport(text: string): boolean {
  // Session-control adapters are used by inactive-session controls such as usage-limit
  // "check now". They must be reachable from the long-running daemon bundle without
  // depending on rebuilt/removed relative chunks or root-level appServer paths.
  const patterns: RegExp[] = [
    /CODEX_APP_SERVER_(?:CATALOG|GOAL|USAGE_LIMIT_RECOVERY)_CONTROL_ADAPTER_MODULE\s*=\s*['"]\.\/appServer\/[^'"]+['"]/,
    /(?:CLAUDE|GEMINI|OPENCODE)_USAGE_LIMIT_RECOVERY_CONTROL_ADAPTER_MODULE\s*=\s*['"]@\/backends\/[^'"]+['"]/,
    /getSession(?:Goal|Catalog|UsageLimitRecovery)ControlAdapter:\s*async\s*\([^)]*\)\s*=>[\s\S]{0,320}(?:import|require)\(\s*['"]\.\/appServer\/[^'"]+['"]\s*\)/,
    /getSession(?:Goal|Catalog|UsageLimitRecovery)ControlAdapter:\s*async\s*\([^)]*\)\s*=>[\s\S]{0,320}(?:import|require)\(\s*['"]\.\/(?:codexAppServer)?(?:Goal|Catalog|UsageLimitRecovery)ControlAdapter-[^'"]+['"]\s*\)/,
    /getSessionUsageLimitRecoveryControlAdapter:\s*async\s*\([^)]*\)\s*=>[\s\S]{0,320}(?:import|require)\(\s*['"]@\/backends\/[^'"]+UsageLimitRecoveryControlAdapter['"]\s*\)/,
  ];

  return patterns.some((p) => p.test(text));
}

function matchesDynamicTerminalHostRegistryImport(text: string): boolean {
  // Explicit Stop may run long after the daemon bundle was loaded. A lazy hashed-chunk
  // import here can disappear when local development replaces dist, after the runner
  // has exited but before its owned terminal host is destroyed.
  return /import\(\s*['"]\.\/defaultRegistry-[^'"]+\.mjs['"]\s*\)/.test(text);
}

function containsStaticSessionControlAdapterWiring(text: string, agentId: 'claude' | 'codex' | 'gemini' | 'opencode'): boolean {
  const expectedUsageAdapterByAgentId = {
    claude: 'claudeUsageLimitRecoveryControlAdapter',
    codex: 'codexAppServerUsageLimitRecoveryControlAdapter',
    gemini: 'geminiUsageLimitRecoveryControlAdapter',
    opencode: 'openCodeUsageLimitRecoveryControlAdapter',
  } satisfies Record<typeof agentId, string>;
  const usageAdapter = expectedUsageAdapterByAgentId[agentId];
  // Each getter must belong to this agent's own catalog entry: the scan may cross any of that
  // entry's other properties but stops where the next agent's `id: AGENTS_CORE.<agent>.id` begins.
  // A fixed character window instead breaks whenever an unrelated property is added to the entry,
  // and a window between two getters would accept one that moved into the next entry.
  const isStaticGetterInOwnEntry = (getter: string, adapter: string) => new RegExp(
    `id:\\s*AGENTS_CORE\\.${agentId}\\.id(?:(?!id:\\s*AGENTS_CORE\\.)[\\s\\S])*?${getter}:\\s*async\\s*\\(\\)\\s*=>\\s*${adapter}\\b`,
  ).test(text);
  if (!isStaticGetterInOwnEntry('getSessionUsageLimitRecoveryControlAdapter', usageAdapter)) return false;
  if (agentId !== 'codex') return true;
  return isStaticGetterInOwnEntry('getSessionGoalControlAdapter', 'codexAppServerGoalControlAdapter')
    && isStaticGetterInOwnEntry('getSessionCatalogControlAdapter', 'codexAppServerCatalogControlAdapter');
}

async function listDistFiles(distDir: string): Promise<string[]> {
  // Focus the scan on the primary built bundles that contain the AGENT catalog wiring.
  // This avoids reading hundreds of unrelated dist chunks, keeping the test fast and stable.
  const isPrimaryBundle = (name: string) => /^(api|index|types)(?:-[^.]+)?\.(?:mjs|cjs)$/.test(name);
  const isAnyBundle = (name: string) => /\.(?:mjs|cjs)$/.test(name);

  // Retry briefly to avoid flaky ENOENT/empty-dir failures when dist is being rebuilt.
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const entries = await fs.readdir(distDir);
      const primaryFiles = entries.filter(isPrimaryBundle).map((entry) => join(distDir, entry));
      if (primaryFiles.length > 0) return primaryFiles;

      const fallbackFiles = entries.filter(isAnyBundle).map((entry) => join(distDir, entry));
      if (fallbackFiles.length > 0) return fallbackFiles;
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  const entries = await fs.readdir(distDir);
  const primaryFiles = entries.filter(isPrimaryBundle).map((entry) => join(distDir, entry));
  if (primaryFiles.length > 0) return primaryFiles;
  return entries.filter(isAnyBundle).map((entry) => join(distDir, entry));
}

function resolveDistBuildLockPath(): string {
  const hash = createHash('sha256').update(projectPath()).digest('hex').slice(0, 12);
  return join(tmpdir(), `happier-cli-vitest-build-lock-${hash}`);
}

async function ensureCliDistReady(distDir: string): Promise<void> {
  const distEntrypoint = join(distDir, 'index.mjs');
  if (existsSync(distEntrypoint)) return;

  await ensureBuildArtifactsReadyOnce({
    lockPath: resolveDistBuildLockPath(),
    markerPaths: [distEntrypoint],
    lockLabel: 'CLI dist build',
    runBuild: () => {
      const pmExecPath = typeof process.env.npm_execpath === 'string' ? process.env.npm_execpath.trim() : '';
      const pmExecPathIsJs = pmExecPath.endsWith('.js') || pmExecPath.endsWith('.cjs') || pmExecPath.endsWith('.mjs');
      const command = pmExecPath
        ? pmExecPathIsJs
          ? process.execPath
          : pmExecPath
        : process.platform === 'win32'
          ? 'npm.cmd'
          : 'npm';
      const args = pmExecPathIsJs ? [pmExecPath, 'run', 'build'] : ['run', 'build'];

      const buildResult = spawnSync(command, args, {
          cwd: projectPath(),
          stdio: 'pipe',
          encoding: 'utf8',
        });

      if (buildResult.error) {
        throw new Error(`Failed to rebuild CLI dist for build-output verification: ${buildResult.error.message}`);
      }

      if ((buildResult.status ?? 1) !== 0) {
        const exitCode = typeof buildResult.status === 'number' ? buildResult.status : 'unknown';
        const stdout = typeof buildResult.stdout === 'string' ? buildResult.stdout.trim() : '';
        const stderr = typeof buildResult.stderr === 'string' ? buildResult.stderr.trim() : '';
        const details = [stdout ? `stdout:\n${stdout}` : '', stderr ? `stderr:\n${stderr}` : '']
          .filter(Boolean)
          .join('\n\n');

        throw new Error(
          `Failed to rebuild CLI dist for build-output verification (exit ${exitCode})${details ? `\n\n${details}` : ''}`,
        );
      }
    },
  });
}

describe('CLI build output', () => {
  const distDir = join(projectPath(), 'dist');
  let distFiles: string[] = [];

  beforeAll(async () => {
    await ensureCliDistReady(distDir);
    distFiles = await listDistFiles(distDir);
  }, 180_000);

  it('does not lazy-load daemon spawn hooks via dynamic import (prevents runtime chunk-missing failures)', async () => {
    expect(distFiles.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of distFiles) {
      const text = await fs.readFile(file, 'utf8');
      if (matchesDynamicSpawnHooksImport(text)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  }, 60_000);

  it('does not lazy-load vendor resume support via dynamic import (prevents runtime chunk-missing failures)', async () => {
    expect(distFiles.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of distFiles) {
      const text = await fs.readFile(file, 'utf8');
      if (matchesDynamicVendorResumeSupportImport(text)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  }, 60_000);

  it('does not lazy-load connected-service daemon recovery hooks via dynamic import chunks', async () => {
    expect(distFiles.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of distFiles) {
      const text = await fs.readFile(file, 'utf8');
      if (matchesDynamicConnectedServiceCatalogHookImport(text)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  }, 60_000);

  it('does not lazy-load session control adapters through runtime-relative imports', async () => {
    expect(distFiles.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    const sawStaticSessionControlWiringByAgentId = new Map([
      ['claude', false],
      ['codex', false],
      ['gemini', false],
      ['opencode', false],
    ] as const);
    for (const file of distFiles) {
      const text = await fs.readFile(file, 'utf8');
      if (matchesDynamicSessionControlAdapterImport(text)) offenders.push(file);
      for (const agentId of sawStaticSessionControlWiringByAgentId.keys()) {
        if (containsStaticSessionControlAdapterWiring(text, agentId)) {
          sawStaticSessionControlWiringByAgentId.set(agentId, true);
        }
      }
    }

    expect(Object.fromEntries(sawStaticSessionControlWiringByAgentId)).toEqual({
      claude: true,
      codex: true,
      gemini: true,
      opencode: true,
    });
    expect(offenders).toEqual([]);
  }, 60_000);

  it('does not lazy-load terminal-host cleanup through a hashed runtime chunk', async () => {
    expect(distFiles.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of distFiles) {
      const text = await fs.readFile(file, 'utf8');
      if (matchesDynamicTerminalHostRegistryImport(text)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  }, 60_000);
});
