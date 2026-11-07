import { dirname, join } from 'node:path';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { makeAcpPermissionOutsideWorkspaceScenario } from '../../src/testkit/providers/scenarios/scenarios.acp';
import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';
import { claudeScenarios } from '../../src/testkit/providers/scenarios/scenarios.claude';
import type { ProviderScenario, ProviderUnderTest } from '../../src/testkit/providers/types';

function claudeProviderStub(): ProviderUnderTest {
  return {
    id: 'claude',
    enableEnvVar: 'HAPPIER_E2E_PROVIDER_CLAUDE',
    protocol: 'claude',
    traceProvider: 'claude',
    scenarioRegistry: { v: 1, tiers: { smoke: [], extended: [] } },
    cli: { subcommand: 'claude' },
  };
}

describe('provider scenarios outside-workspace policy', () => {
  it('uses workspace-parent path policy for claude outside-workspace prompts', () => {
    const workspaceDir = '/tmp/workspace-root';
    const scenario = scenarioCatalog.permission_surface_outside_workspace(claudeProviderStub());
    const promptBuilder = scenario.prompt;
    expect(typeof promptBuilder).toBe('function');
    if (!promptBuilder) throw new Error('Scenario prompt builder is required');
    const prompt = promptBuilder({ workspaceDir });

    const match = prompt.match(/- Absolute path: (.+)/);
    expect(match).toBeTruthy();
    const outsidePath = match?.[1]?.trim() ?? '';

    expect(outsidePath.startsWith(workspaceDir)).toBe(false);
    expect(dirname(outsidePath)).toBe(dirname(workspaceDir));
  });

  it('initializes outside path in setup for ACP outside-workspace scenario', () => {
    const scenario = makeAcpPermissionOutsideWorkspaceScenario({
      providerId: 'opencode',
      content: 'OUTSIDE_POLICY_TEST',
      decision: 'approve',
    });

    expect(typeof scenario.setup).toBe('function');
    const promptBuilder = scenario.prompt;
    expect(typeof promptBuilder).toBe('function');
    if (!promptBuilder) throw new Error('Scenario prompt builder is required');

    const workspaceDir = '/tmp/workspace-root';
    const prompt = promptBuilder({ workspaceDir });
    const match = prompt.match(/- Absolute path: (.+)/);
    expect(match).toBeTruthy();
    const outsidePath = match?.[1]?.trim() ?? '';
    expect(outsidePath.startsWith(workspaceDir)).toBe(false);
    // OpenCode-family providers often treat the workspace as a git-rooted project, so we force tmpdir().
    expect(outsidePath.startsWith(tmpdir())).toBe(true);
  });
});


// Only these direct scenario methods run: no provider process, session or transport.
const cleanupCases = (['catalog', 'acp', 'legacy'] as const).flatMap((owner) =>
  (['approve', 'deny'] as const).map((decision) => ({ owner, decision })),
);

function cleanupScenario(owner: 'catalog' | 'acp' | 'legacy', decision: 'approve' | 'deny'): ProviderScenario {
  const id = decision === 'approve' ? 'permission_surface_outside_workspace' : 'permission_deny_outside_workspace';
  if (owner === 'catalog') return scenarioCatalog[id](claudeProviderStub());
  if (owner === 'acp') return makeAcpPermissionOutsideWorkspaceScenario({
    providerId: 'codex', content: 'OUTSIDE_OWNED_TEST', decision,
  });
  const scenario = claudeScenarios.find((value) => value.id === id);
  if (!scenario) throw new Error('Missing legacy permission scenario');
  return scenario;
}

describe.each(cleanupCases)('$owner $decision cleanup ownership', ({ owner, decision }) => {
  it.each(['mismatch', 'matching', 'missing'] as const)('preserves unrelated data with %s evidence', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-owned-permission-'));
    const workspaceDir = join(root, 'workspace');
    const unrelated = join(root, 'unrelated.txt');
    try {
      await mkdir(workspaceDir);
      const scenario = cleanupScenario(owner, decision);
      if (!scenario.setup || !scenario.prompt || !scenario.verify) throw new Error('Scenario lifecycle is required');
      await scenario.setup({ workspaceDir, cliHome: workspaceDir });
      const prompt = scenario.prompt({ workspaceDir });
      const ownedPath = prompt.match(/^- Absolute path: (.+)$/m)?.[1]?.trim();
      if (!ownedPath || dirname(ownedPath) !== root) throw new Error('Fixture target escaped its disposable root');
      const marker = owner === 'acp' ? 'OUTSIDE_OWNED_TEST' : 'OUTSIDE_CLAUDE_E2E';
      if (decision === 'approve' || kind !== 'matching') await writeFile(ownedPath, marker, 'utf8');
      await writeFile(unrelated, 'unrelated fixture sentinel', 'utf8');
      // Deletion depends on the parent directory, not the file's write permission.
      await chmod(unrelated, 0o444);
      const reported = kind === 'mismatch' ? unrelated : ownedPath;
      const key = owner === 'acp' ? 'acp/codex/permission-request/Write' : 'claude/claude/permission-request/Write';
      const payload = owner === 'acp'
        ? { options: { input: { filepath: reported } } }
        : { input: { file_path: reported } };
      const verification = scenario.verify({
        workspaceDir, fixtures: { examples: kind === 'missing' ? {} : { [key]: [{ payload }] } },
        traceEvents: [], baseUrl: 'http://127.0.0.1:1', token: 'unused', sessionId: 'unused',
        resumeSessionId: null, secret: new Uint8Array(32), resumeId: null,
      });
      if (kind === 'matching') await expect(verification).resolves.toBeUndefined();
      else await expect(verification).rejects.toThrow();
      expect(await readFile(unrelated, 'utf8')).toBe('unrelated fixture sentinel');
      expect(existsSync(ownedPath)).toBe(false);
    } finally {
      // Both target and sentinel belong to this one freshly created test root.
      await rm(root, { recursive: true, force: true });
    }
  });
});
