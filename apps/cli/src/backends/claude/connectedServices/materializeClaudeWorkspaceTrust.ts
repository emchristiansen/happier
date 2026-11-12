import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { resolveHomeDirFromEnvironment } from '@happier-dev/cli-common/providers';

import { resolveConfiguredClaudeConfigDir } from '@/backends/claude/utils/resolveConfiguredClaudeConfigDir';
import { resolveClaudeConfigDirOverride } from '@/backends/claude/utils/resolveClaudeConfigDirOverride';
import {
  readClaudeRootConfigFile,
  sanitizeClaudeOauthAccountProjection,
} from './claudeRootConfig';

type JsonObject = Record<string, unknown>;

type ClaudeWorkspaceTrustProjection = Readonly<{
  hasTrustDialogAccepted: true;
  hasCompletedProjectOnboarding?: true;
}>;

type ClaudeOauthAccountProjection = Record<string, unknown>;

type ClaudeRootConfigPathCandidate = Readonly<{
  rootDir: string;
  path: string;
}>;

function readObject(value: unknown): JsonObject | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function dedupeRootConfigPathCandidates(
  candidates: readonly ClaudeRootConfigPathCandidate[],
): ClaudeRootConfigPathCandidate[] {
  const seen = new Set<string>();
  const result: ClaudeRootConfigPathCandidate[] = [];
  for (const candidate of candidates) {
    const key = resolve(candidate.path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

/**
 * Root config files of the one permitted Claude configuration source. An explicit config-dir
 * override is the whole source identity (native Claude then reads only `<override>/.claude.json`),
 * so the ambient HOME is never consulted; without an override the native HOME layout is the source.
 */
export function resolveClaudeRootConfigPathCandidates(env: NodeJS.ProcessEnv): ClaudeRootConfigPathCandidate[] {
  const explicitConfigDir = resolveClaudeConfigDirOverride(env);
  if (explicitConfigDir) {
    return [{ rootDir: explicitConfigDir, path: join(explicitConfigDir, '.claude.json') }];
  }
  const homeDir = resolveHomeDirFromEnvironment(env);
  const configuredConfigDir = resolveConfiguredClaudeConfigDir({ env });
  return dedupeRootConfigPathCandidates([
    {
      rootDir: homeDir,
      path: join(homeDir, '.claude.json'),
    },
    {
      rootDir: configuredConfigDir,
      path: join(configuredConfigDir, '.claude.json'),
    },
  ]);
}

/**
 * The permitted source's decision about one workspace. Explicit distrust and silence are different:
 * distrust revokes a trust the target kept from an earlier projection, while silence leaves the
 * target's own state alone.
 */
type ClaudeWorkspaceTrustDecision =
  | Readonly<{ kind: 'trusted'; projection: ClaudeWorkspaceTrustProjection }>
  | Readonly<{ kind: 'distrusted' }>
  | Readonly<{ kind: 'silent' }>;

function readProjectTrustDecision(
  rootConfig: JsonObject,
  sessionDirectory: string,
): ClaudeWorkspaceTrustDecision {
  const projectConfig = readObject(readObject(rootConfig.projects)?.[sessionDirectory]);
  if (!projectConfig || typeof projectConfig.hasTrustDialogAccepted !== 'boolean') {
    return { kind: 'silent' };
  }
  if (projectConfig.hasTrustDialogAccepted !== true) {
    return { kind: 'distrusted' };
  }
  return {
    kind: 'trusted',
    projection: {
      hasTrustDialogAccepted: true,
      ...(projectConfig.hasCompletedProjectOnboarding === true ? { hasCompletedProjectOnboarding: true } : {}),
    },
  };
}

async function resolveWorkspaceTrustDecision(params: Readonly<{
  sourceEnv: NodeJS.ProcessEnv;
  sessionDirectory: string;
  targetDir: string;
}>): Promise<ClaudeWorkspaceTrustDecision> {
  const targetRoot = resolve(params.targetDir);
  const candidates = resolveClaudeRootConfigPathCandidates(params.sourceEnv)
    .filter((candidate) => resolve(candidate.rootDir) !== targetRoot);
  for (const candidate of candidates) {
    const rootConfig = await readClaudeRootConfigFile(candidate.path);
    if (!rootConfig) continue;
    const decision = readProjectTrustDecision(rootConfig, params.sessionDirectory);
    // The first explicit decision, trust or distrust, is the user's own answer for this directory.
    if (decision.kind !== 'silent') return decision;
  }
  return { kind: 'silent' };
}

async function resolveClaudeOauthAccountProjection(params: Readonly<{
  sourceEnv: NodeJS.ProcessEnv;
  targetDir: string;
}>): Promise<ClaudeOauthAccountProjection | null> {
  const targetRoot = resolve(params.targetDir);
  const candidates = resolveClaudeRootConfigPathCandidates(params.sourceEnv)
    .filter((candidate) => resolve(candidate.rootDir) !== targetRoot);
  for (const candidate of candidates) {
    const rootConfig = await readClaudeRootConfigFile(candidate.path);
    if (!rootConfig) continue;
    const sanitized = sanitizeClaudeOauthAccountProjection(rootConfig.oauthAccount);
    if (sanitized) return sanitized;
  }
  return null;
}

async function resolveClaudeCompletedOnboardingProjection(params: Readonly<{
  sourceEnv: NodeJS.ProcessEnv;
  targetDir: string;
}>): Promise<true | null> {
  const targetRoot = resolve(params.targetDir);
  const candidates = resolveClaudeRootConfigPathCandidates(params.sourceEnv)
    .filter((candidate) => resolve(candidate.rootDir) !== targetRoot);
  for (const candidate of candidates) {
    const rootConfig = await readClaudeRootConfigFile(candidate.path);
    if (!rootConfig || typeof rootConfig.hasCompletedOnboarding !== 'boolean') continue;
    return rootConfig.hasCompletedOnboarding === true ? true : null;
  }
  return null;
}

async function writeClaudeRootConfig(params: Readonly<{
  targetDir: string;
  rootConfig: JsonObject;
}>): Promise<void> {
  await mkdir(params.targetDir, { recursive: true });
  const targetPath = join(params.targetDir, '.claude.json');
  const tempPath = join(params.targetDir, `.claude.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(params.rootConfig)}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') {
      await chmod(tempPath, 0o600);
    }
    await rename(tempPath, targetPath);
    if (process.platform !== 'win32') {
      await chmod(targetPath, 0o600);
    }
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function materializeClaudeWorkspaceTrust(params: Readonly<{
  sourceEnv: NodeJS.ProcessEnv;
  targetDir: string;
  sessionDirectory?: string | null;
  preserveExistingOauthAccountProjection?: boolean | undefined;
}>): Promise<void> {
  const sessionDirectory = typeof params.sessionDirectory === 'string' && params.sessionDirectory.trim().length > 0
    ? resolve(params.sessionDirectory.trim())
    : null;
  if (!sessionDirectory) return;

  const decision = await resolveWorkspaceTrustDecision({
    sourceEnv: params.sourceEnv,
    sessionDirectory,
    targetDir: params.targetDir,
  });
  const hasCompletedOnboarding = await resolveClaudeCompletedOnboardingProjection({
    sourceEnv: params.sourceEnv,
    targetDir: params.targetDir,
  });
  if (decision.kind === 'silent' && !hasCompletedOnboarding) return;

  const existingRoot = await readClaudeRootConfigFile(join(params.targetDir, '.claude.json')) ?? {};
  const existingProjects = readObject(existingRoot.projects) ?? {};
  // Merge into any claude-written project entry instead of replacing it, so rematerialization does
  // not clobber per-project state (allowedTools, history, ...).
  const existingProjectEntry = readObject(existingProjects[sessionDirectory]) ?? {};
  const projectEntry = decision.kind === 'trusted'
    ? { ...existingProjectEntry, ...decision.projection }
    : decision.kind === 'distrusted' && existingProjectEntry.hasTrustDialogAccepted === true
      ? { ...existingProjectEntry, hasTrustDialogAccepted: false }
      : null;
  if (!projectEntry && !hasCompletedOnboarding) return;

  const oauthAccount = decision.kind === 'trusted'
    ? params.preserveExistingOauthAccountProjection === true
      ? sanitizeClaudeOauthAccountProjection(existingRoot.oauthAccount)
      : await resolveClaudeOauthAccountProjection({
          sourceEnv: params.sourceEnv,
          targetDir: params.targetDir,
        })
    : null;
  await writeClaudeRootConfig({
    targetDir: params.targetDir,
    rootConfig: {
      ...existingRoot,
      ...(oauthAccount ? { oauthAccount } : {}),
      ...(hasCompletedOnboarding ? { hasCompletedOnboarding } : {}),
      ...(projectEntry
        ? { projects: { ...existingProjects, [sessionDirectory]: projectEntry } }
        : {}),
    },
  });
}
