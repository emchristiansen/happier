import { createReadStream, accessSync, constants as fsConstants, existsSync } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import {
  downloadGitHubReleaseAsset,
  promoteManagedInstallCandidate,
} from '@happier-dev/cli-common/providers';
import { AGY_ACP_SERVER_VERSION } from '@happier-dev/protocol/installables';
import { extractArchivePayloadToDirectory } from '@happier-dev/release-runtime/archiveExtraction';

import { configuration } from '@/configuration';
import { readRuntimeInstallableLastCheckAtMs } from '@/installables/runtime/runtimeInstallableUpdateState';
import { resolveAgyAcpReleaseAsset } from '@/runtime/managedTools/providers/agyAcpRelease';

type AgyAcpState = Readonly<{
  installedVersion: string | null;
  executableSha256: string | null;
  executableSize: number | null;
  executableMtimeMs: number | null;
  lastInstallLogPath: string | null;
}>;

type LatestVersionCheck =
  | Readonly<{ ok: true; latestVersion: string | null; label: string | null }>
  | Readonly<{ ok: false; errorMessage: string }>;

type AgyAcpInstallDeps = Readonly<{
  downloadArchive: typeof downloadGitHubReleaseAsset;
  extractArchive: typeof extractArchivePayloadToDirectory;
}>;

const DEFAULT_INSTALL_DEPS: AgyAcpInstallDeps = {
  downloadArchive: downloadGitHubReleaseAsset,
  extractArchive: extractArchivePayloadToDirectory,
};

export const agyAcpInstallDir = () => join(configuration.happyHomeDir, 'tools', 'agy-acp-server');

function currentRoot(): string {
  return join(agyAcpInstallDir(), 'current');
}

function safeExecutablePath(root: string, executableSubpath: string): string | null {
  if (isAbsolute(executableSubpath)) return null;
  const candidate = join(root, executableSubpath);
  const fromRoot = relative(root, candidate);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromRoot)) {
    return null;
  }
  return candidate;
}

function currentExecutableSubpath(): string | null {
  try {
    return resolveAgyAcpReleaseAsset().executableSubpath;
  } catch {
    return null;
  }
}

function isManagedBinRunnable(candidatePath: string): boolean {
  const accessMode = process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  try {
    accessSync(candidatePath, accessMode);
    return true;
  } catch {
    return false;
  }
}

export function resolveExistingAgyAcpManagedBinPath(): string | null {
  const subpath = currentExecutableSubpath();
  if (!subpath) return null;
  const candidate = safeExecutablePath(currentRoot(), subpath);
  if (!candidate) return null;
  try {
    if (existsSync(candidate) && isManagedBinRunnable(candidate)) return candidate;
  } catch {
    // ignore invalid paths
  }
  return null;
}

const agyAcpStatePath = () => join(agyAcpInstallDir(), 'install-state.json');

async function readAgyAcpState(): Promise<AgyAcpState> {
  try {
    const raw = await readFile(agyAcpStatePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      installedVersion: typeof parsed?.installedVersion === 'string' ? parsed.installedVersion : null,
      executableSha256: typeof parsed?.executableSha256 === 'string' && /^[a-f0-9]{64}$/.test(parsed.executableSha256)
        ? parsed.executableSha256
        : null,
      executableSize: typeof parsed?.executableSize === 'number' && Number.isFinite(parsed.executableSize)
        ? parsed.executableSize
        : null,
      executableMtimeMs: typeof parsed?.executableMtimeMs === 'number' && Number.isFinite(parsed.executableMtimeMs)
        ? parsed.executableMtimeMs
        : null,
      lastInstallLogPath: typeof parsed?.lastInstallLogPath === 'string' ? parsed.lastInstallLogPath : null,
    };
  } catch {
    return {
      installedVersion: null,
      executableSha256: null,
      executableSize: null,
      executableMtimeMs: null,
      lastInstallLogPath: null,
    };
  }
}

async function sha256File(filePath: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk);
  }
  return digest.digest('hex');
}

/**
 * Binding the installed payload into state lets the asynchronous installable owner
 * reject post-install corruption. Unchanged metadata avoids re-hashing the large
 * server on each launch; changed metadata is checked against the stored digest.
 * The synchronous resolver intentionally remains a path/runnability lookup for
 * spawn after an authoritative ensure succeeds.
 */
export async function verifyExistingAgyAcpManagedBinPath(): Promise<string | null> {
  const candidate = resolveExistingAgyAcpManagedBinPath();
  if (!candidate) return null;
  const state = await readAgyAcpState();
  if (!state.executableSha256) return null;
  try {
    const metadata = await stat(candidate);
    if (metadata.size === state.executableSize && metadata.mtimeMs === state.executableMtimeMs) {
      return candidate;
    }
    return (await sha256File(candidate)) === state.executableSha256 ? candidate : null;
  } catch {
    return null;
  }
}

async function writeAgyAcpState(next: AgyAcpState): Promise<void> {
  await mkdir(agyAcpInstallDir(), { recursive: true });
  await writeFile(agyAcpStatePath(), JSON.stringify(next, null, 2), 'utf8');
}

async function writeInstallLog(params: Readonly<{ logPath: string; lines: string[] }>): Promise<void> {
  await mkdir(dirname(params.logPath), { recursive: true });
  await writeFile(params.logPath, `${params.lines.join('\n')}\n`, 'utf8');
}

async function installPinnedAgyAcpRelease(
  logPath: string,
  deps: AgyAcpInstallDeps,
): Promise<Readonly<{
  version: string | null;
  executableSha256: string;
  executableSize: number;
  executableMtimeMs: number;
}>> {
  const asset = resolveAgyAcpReleaseAsset();
  const installDir = agyAcpInstallDir();
  await mkdir(installDir, { recursive: true });
  // Promotion uses rename, so staging must share the destination filesystem.
  const scratchDir = await mkdtemp(join(installDir, '.install-'));
  try {
    const archivePath = join(scratchDir, basename(asset.name));
    const extractDir = join(scratchDir, 'extract');

    await deps.downloadArchive({
      url: asset.url,
      destinationPath: archivePath,
      digest: `sha256:${asset.sha256}`,
      userAgent: 'happier-cli',
    });

    await rm(extractDir, { recursive: true, force: true });
    await deps.extractArchive({
      archivePath,
      archiveName: asset.name,
      extractDir,
      limits: asset.archiveExtractionLimits,
    });
    const candidateExecutable = safeExecutablePath(extractDir, asset.executableSubpath);
    if (!candidateExecutable) {
      throw new Error('Pinned agy-acp-server executable path is unsafe');
    }
    try {
      await access(candidateExecutable, fsConstants.F_OK);
    } catch {
      throw new Error(`Pinned agy-acp-server executable missing at ${asset.executableSubpath}`);
    }

    // Google's ZIP has no wrapper directory. Keep the server and its companion
    // localharness executable together at current/<subpath>.
    const installedExecutable = safeExecutablePath(extractDir, asset.executableSubpath);
    if (!installedExecutable) {
      throw new Error('Pinned agy-acp-server executable path is unsafe');
    }
    if (process.platform !== 'win32') {
      await chmod(installedExecutable, 0o755);
    }

    const executableSha256 = await sha256File(installedExecutable);
    const executableMetadata = await stat(installedExecutable);
    await writeInstallLog({
      logPath,
      lines: [
        '# source: pinned_archive',
        `# version: ${asset.version ?? 'unknown'}`,
        `# asset: ${asset.name}`,
        `# url: ${asset.url}`,
        `# sha256: ${asset.sha256}`,
        `# executableSubpath: ${asset.executableSubpath}`,
        `# executableSha256: ${executableSha256}`,
      ],
    });
    await promoteManagedInstallCandidate({
      installRoot: installDir,
      candidateDir: extractDir,
      logPath,
    });
    return {
      version: asset.version,
      executableSha256,
      executableSize: executableMetadata.size,
      executableMtimeMs: executableMetadata.mtimeMs,
    };
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

// Existing in-flight coalescing: concurrent prewarm + launch joins one download
// instead of starting a second one. One hung shared promise would poison later
// callers, so the entry is cleared on settle and failures remain retryable.
let inFlightInstall: Promise<{ ok: true; logPath: string } | { ok: false; errorMessage: string; logPath: string }> | null = null;

export function __resetAgyAcpInFlightForTests(): void {
  inFlightInstall = null;
}

async function runInstall(
  deps: AgyAcpInstallDeps,
): Promise<{ ok: true; logPath: string } | { ok: false; errorMessage: string; logPath: string }> {
  const logPath = join(configuration.logsDir, `install-dep-agy-acp-server-${Date.now()}.log`);
  try {
    const installed = await installPinnedAgyAcpRelease(logPath, deps);
    await writeAgyAcpState({
      installedVersion: installed.version,
      executableSha256: installed.executableSha256,
      executableSize: installed.executableSize,
      executableMtimeMs: installed.executableMtimeMs,
      lastInstallLogPath: logPath,
    });
    return { ok: true, logPath };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Install failed';
    try {
      await writeInstallLog({ logPath, lines: [errorMessage] });
      const previousState = await readAgyAcpState();
      await writeAgyAcpState({
        installedVersion: previousState.installedVersion,
        executableSha256: previousState.executableSha256,
        executableSize: previousState.executableSize,
        executableMtimeMs: previousState.executableMtimeMs,
        lastInstallLogPath: logPath,
      });
    } catch {
      // best-effort state persistence
    }
    return { ok: false, errorMessage, logPath };
  }
}

export function installAgyAcp(
  depsOverrides: Partial<AgyAcpInstallDeps> = {},
): Promise<{ ok: true; logPath: string } | { ok: false; errorMessage: string; logPath: string }> {
  const existing = inFlightInstall;
  if (existing) return existing;
  const deps = { ...DEFAULT_INSTALL_DEPS, ...depsOverrides };
  const next = runInstall(deps).finally(() => {
    if (inFlightInstall === next) inFlightInstall = null;
  });
  inFlightInstall = next;
  return next;
}

export type AgyAcpDepData = Readonly<{
  installed: boolean;
  installDir: string;
  binPath: string | null;
  installedVersion: string | null;
  sourceKind: 'pinned_archive';
  lastInstallLogPath: string | null;
  lastBackgroundUpdateCheckAtMs: number | null;
  latestVersionCheck?: LatestVersionCheck;
}>;

export async function getAgyAcpDepStatus(opts?: { includeLatestVersion?: boolean; onlyIfInstalled?: boolean }): Promise<AgyAcpDepData> {
  const installDir = agyAcpInstallDir();
  const state = await readAgyAcpState();
  const binPath = await verifyExistingAgyAcpManagedBinPath();
  const includeLatestVersion = opts?.includeLatestVersion === true;
  const onlyIfInstalled = opts?.onlyIfInstalled === true;
  const latestVersionCheck: LatestVersionCheck | undefined =
    includeLatestVersion && (!onlyIfInstalled || binPath !== null)
      ? { ok: true, latestVersion: AGY_ACP_SERVER_VERSION, label: AGY_ACP_SERVER_VERSION }
      : undefined;
  const lastBackgroundUpdateCheckAtMs = await readRuntimeInstallableLastCheckAtMs('agy-acp-server');

  return {
    installed: binPath !== null,
    installDir,
    binPath,
    installedVersion: state.installedVersion,
    sourceKind: 'pinned_archive',
    lastInstallLogPath: state.lastInstallLogPath,
    lastBackgroundUpdateCheckAtMs,
    ...(latestVersionCheck ? { latestVersionCheck } : {}),
  };
}
