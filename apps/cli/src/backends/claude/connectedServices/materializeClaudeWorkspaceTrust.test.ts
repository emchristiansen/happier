import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { materializeClaudeWorkspaceTrust } from './materializeClaudeWorkspaceTrust';

describe('materializeClaudeWorkspaceTrust', () => {
  it('does not treat the isolated target config root as a trust authority or replace it with inferred trust', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-home-'));
    const targetDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-target-'));
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'happier-claude-trust-project-'));
    const existingTargetConfig = {
      oauthAccount: { accessToken: 'target-root-token-must-not-influence-trust' },
      projects: {
        [sessionDirectory]: {
          hasTrustDialogAccepted: false,
          allowedTools: ['Bash(*)'],
        },
      },
    };
    const targetConfigPath = join(targetDir, '.claude.json');
    await writeFile(targetConfigPath, `${JSON.stringify(existingTargetConfig)}\n`);

    await materializeClaudeWorkspaceTrust({
      sourceEnv: {
        CLAUDE_CONFIG_DIR: targetDir,
        HOME: homeDir,
      },
      targetDir,
      sessionDirectory,
    });

    const written = JSON.parse(await readFile(targetConfigPath, 'utf8')) as Record<string, unknown>;
    // Target-root distrust is target-owned state, not ambient authority. With no explicit ambient
    // acceptance, materialization must leave it untouched for the Trust/Exit dialog owner.
    expect(written.projects).toEqual({
      [sessionDirectory]: {
        hasTrustDialogAccepted: false,
        allowedTools: ['Bash(*)'],
      },
    });
  });

  it('does not write workspace trust when no source config carries explicit trust state', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-home-'));
    const targetDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-target-'));
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'happier-claude-trust-project-'));

    await materializeClaudeWorkspaceTrust({
      sourceEnv: {
        HOME: homeDir,
      },
      targetDir,
      sessionDirectory,
    });

    await expect(readFile(join(targetDir, '.claude.json'), 'utf8')).rejects.toThrow();
  });

  it('projects ambient onboarding root-only while respecting an explicit user distrust decision', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-home-'));
    const sourceDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-source-'));
    const targetDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-target-'));
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'happier-claude-trust-project-'));

    await writeFile(
      join(sourceDir, '.claude.json'),
      `${JSON.stringify({
        hasCompletedOnboarding: true,
        projects: {
          [sessionDirectory]: { hasTrustDialogAccepted: false },
        },
      })}\n`,
    );

    await materializeClaudeWorkspaceTrust({
      sourceEnv: {
        CLAUDE_CONFIG_DIR: sourceDir,
        HOME: homeDir,
      },
      targetDir,
      sessionDirectory,
    });

    const written = JSON.parse(await readFile(join(targetDir, '.claude.json'), 'utf8')) as {
      hasCompletedOnboarding?: boolean;
      projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };
    expect(written.hasCompletedOnboarding).toBe(true);
    expect(written.projects?.[sessionDirectory]?.hasTrustDialogAccepted).not.toBe(true);
  });

  it('projects ambient onboarding root-only without synthesizing missing workspace trust', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-home-'));
    const targetDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-target-'));
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'happier-claude-trust-project-'));
    await writeFile(join(homeDir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));

    await materializeClaudeWorkspaceTrust({
      sourceEnv: { HOME: homeDir },
      targetDir,
      sessionDirectory,
    });

    const written = JSON.parse(await readFile(join(targetDir, '.claude.json'), 'utf8')) as {
      hasCompletedOnboarding?: boolean;
      projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };
    expect(written.hasCompletedOnboarding).toBe(true);
    expect(written.projects?.[sessionDirectory]?.hasTrustDialogAccepted).not.toBe(true);
  });

  it('merges the trust projection into an existing target project entry without dropping claude-written state', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-home-'));
    const sourceDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-source-'));
    const targetDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-target-'));
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'happier-claude-trust-project-'));

    await writeFile(
      join(sourceDir, '.claude.json'),
      `${JSON.stringify({
        projects: {
          [sessionDirectory]: { hasTrustDialogAccepted: true },
        },
      })}\n`,
    );
    await writeFile(
      join(targetDir, '.claude.json'),
      `${JSON.stringify({
        projects: {
          [sessionDirectory]: {
            hasTrustDialogAccepted: false,
            allowedTools: ['Bash(ls:*)'],
            history: [{ display: 'previous prompt' }],
          },
        },
      })}\n`,
    );

    await materializeClaudeWorkspaceTrust({
      sourceEnv: {
        CLAUDE_CONFIG_DIR: sourceDir,
        HOME: homeDir,
      },
      targetDir,
      sessionDirectory,
    });

    const written = JSON.parse(await readFile(join(targetDir, '.claude.json'), 'utf8')) as Record<string, unknown>;
    expect(written.projects).toEqual({
      [sessionDirectory]: {
        hasTrustDialogAccepted: true,
        allowedTools: ['Bash(ls:*)'],
        history: [{ display: 'previous prompt' }],
      },
    });
  });

  it('preserves sanitized oauth account metadata from the selected Claude root while projecting trust', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-home-'));
    const sourceDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-source-'));
    const targetDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-target-'));
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'happier-claude-trust-project-'));

    await writeFile(
      join(sourceDir, '.claude.json'),
      `${JSON.stringify({
        oauthAccount: {
          emailAddress: 'selected@example.test',
          displayName: 'Selected User',
          accessToken: 'must-not-copy',
          refreshToken: 'must-not-copy',
        },
        projects: {
          [sessionDirectory]: {
            hasTrustDialogAccepted: true,
            hasCompletedProjectOnboarding: true,
          },
        },
      })}\n`,
    );

    await materializeClaudeWorkspaceTrust({
      sourceEnv: {
        CLAUDE_CONFIG_DIR: sourceDir,
        HOME: homeDir,
      },
      targetDir,
      sessionDirectory,
    });

    const written = JSON.parse(await readFile(join(targetDir, '.claude.json'), 'utf8')) as Record<string, unknown>;
    expect(written.oauthAccount).toEqual({
      emailAddress: 'selected@example.test',
      displayName: 'Selected User',
    });
    expect(written.projects).toEqual({
      [sessionDirectory]: {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      },
    });
  });

  it('projects the exact top-level onboarding-complete boolean from the explicit Claude config root', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-home-'));
    const sourceDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-source-'));
    const targetDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-target-'));
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'happier-claude-trust-project-'));

    await writeFile(join(sourceDir, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true,
      projects: { [sessionDirectory]: { hasTrustDialogAccepted: true } },
    }));
    await writeFile(join(homeDir, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: false,
    }));

    await materializeClaudeWorkspaceTrust({
      sourceEnv: { CLAUDE_CONFIG_DIR: sourceDir, HOME: homeDir },
      targetDir,
      sessionDirectory,
    });

    const written = JSON.parse(await readFile(join(targetDir, '.claude.json'), 'utf8')) as Record<string, unknown>;
    expect(written.hasCompletedOnboarding).toBe(true);
  });

  it('does not project onboarding completion from the ambient HOME root when an explicit Claude config dir is set', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-home-'));
    const sourceDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-source-'));
    const targetDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-target-'));
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'happier-claude-trust-project-'));

    await writeFile(join(sourceDir, '.claude.json'), JSON.stringify({
      projects: { [sessionDirectory]: { hasTrustDialogAccepted: true } },
    }));
    await writeFile(join(homeDir, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true,
    }));

    await materializeClaudeWorkspaceTrust({
      sourceEnv: { CLAUDE_CONFIG_DIR: sourceDir, HOME: homeDir },
      targetDir,
      sessionDirectory,
    });

    const written = JSON.parse(await readFile(join(targetDir, '.claude.json'), 'utf8')) as Record<string, unknown>;
    expect(written.hasCompletedOnboarding).toBeUndefined();
    expect(written.projects).toEqual({ [sessionDirectory]: { hasTrustDialogAccepted: true } });
  });

  it.each([undefined, false])('does not synthesize onboarding completion into an empty target from source %s', async (hasCompletedOnboarding) => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-home-'));
    const sourceDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-source-'));
    const targetDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-target-'));
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'happier-claude-trust-project-'));
    await writeFile(join(sourceDir, '.claude.json'), JSON.stringify({
      ...(hasCompletedOnboarding === undefined ? {} : { hasCompletedOnboarding }),
      projects: { [sessionDirectory]: { hasTrustDialogAccepted: true } },
    }));

    await materializeClaudeWorkspaceTrust({
      sourceEnv: { CLAUDE_CONFIG_DIR: sourceDir, HOME: homeDir },
      targetDir,
      sessionDirectory,
    });

    const written = JSON.parse(await readFile(join(targetDir, '.claude.json'), 'utf8')) as Record<string, unknown>;
    expect(written).not.toHaveProperty('hasCompletedOnboarding');
    expect(written.projects).toEqual({ [sessionDirectory]: { hasTrustDialogAccepted: true } });
  });

  it.each([undefined, true])(
    'revokes a trust the target kept when the source now explicitly distrusts the directory (source onboarding %s)',
    async (hasCompletedOnboarding) => {
      const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-home-'));
      const sourceDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-source-'));
      const targetDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-target-'));
      const sessionDirectory = await mkdtemp(join(tmpdir(), 'happier-claude-trust-project-'));
      const otherDirectory = await mkdtemp(join(tmpdir(), 'happier-claude-trust-other-'));
      await writeFile(join(sourceDir, '.claude.json'), JSON.stringify({
        ...(hasCompletedOnboarding === undefined ? {} : { hasCompletedOnboarding }),
        projects: { [sessionDirectory]: { hasTrustDialogAccepted: false } },
      }));
      await writeFile(join(targetDir, '.claude.json'), JSON.stringify({
        targetOwnedSetting: 'kept',
        projects: {
          [sessionDirectory]: {
            hasTrustDialogAccepted: true,
            allowedTools: ['Bash(ls)'],
            history: [{ display: 'earlier prompt' }],
          },
          [otherDirectory]: { hasTrustDialogAccepted: true },
        },
      }));

      await materializeClaudeWorkspaceTrust({
        sourceEnv: { CLAUDE_CONFIG_DIR: sourceDir, HOME: homeDir },
        targetDir,
        sessionDirectory,
      });

      const written = JSON.parse(await readFile(join(targetDir, '.claude.json'), 'utf8')) as Record<string, unknown>;
      expect(written).toEqual({
        targetOwnedSetting: 'kept',
        ...(hasCompletedOnboarding === true ? { hasCompletedOnboarding: true } : {}),
        projects: {
          [sessionDirectory]: {
            hasTrustDialogAccepted: false,
            allowedTools: ['Bash(ls)'],
            history: [{ display: 'earlier prompt' }],
          },
          [otherDirectory]: { hasTrustDialogAccepted: true },
        },
      });
    },
  );

  it('keeps the target trust decision when the source is silent about the directory', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-home-'));
    const sourceDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-source-'));
    const targetDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-target-'));
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'happier-claude-trust-project-'));
    await writeFile(join(sourceDir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: {} }));
    await writeFile(join(targetDir, '.claude.json'), JSON.stringify({
      projects: { [sessionDirectory]: { hasTrustDialogAccepted: true, allowedTools: ['Bash(ls)'] } },
    }));

    await materializeClaudeWorkspaceTrust({
      sourceEnv: { CLAUDE_CONFIG_DIR: sourceDir, HOME: homeDir },
      targetDir,
      sessionDirectory,
    });

    const written = JSON.parse(await readFile(join(targetDir, '.claude.json'), 'utf8')) as Record<string, unknown>;
    expect(written).toEqual({
      hasCompletedOnboarding: true,
      projects: { [sessionDirectory]: { hasTrustDialogAccepted: true, allowedTools: ['Bash(ls)'] } },
    });
  });

  it('preserves an existing target onboarding decision when no source completion is projected', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-home-'));
    const sourceDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-source-'));
    const targetDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-target-'));
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'happier-claude-trust-project-'));
    await writeFile(join(sourceDir, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: false,
      projects: { [sessionDirectory]: { hasTrustDialogAccepted: true } },
    }));
    await writeFile(join(targetDir, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true,
      targetOwnedSetting: 'kept',
    }));

    await materializeClaudeWorkspaceTrust({
      sourceEnv: { CLAUDE_CONFIG_DIR: sourceDir, HOME: homeDir },
      targetDir,
      sessionDirectory,
    });

    const written = JSON.parse(await readFile(join(targetDir, '.claude.json'), 'utf8')) as Record<string, unknown>;
    expect(written).toMatchObject({ hasCompletedOnboarding: true, targetOwnedSetting: 'kept' });
  });

  it('applies source onboarding completion over an existing false target without clobbering target state', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-home-'));
    const sourceDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-source-'));
    const targetDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-target-'));
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'happier-claude-trust-project-'));
    await writeFile(join(sourceDir, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true,
      projects: { [sessionDirectory]: { hasTrustDialogAccepted: true } },
    }));
    await writeFile(join(targetDir, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: false,
      targetOwnedSetting: 'kept',
    }));

    await materializeClaudeWorkspaceTrust({
      sourceEnv: { CLAUDE_CONFIG_DIR: sourceDir, HOME: homeDir },
      targetDir,
      sessionDirectory,
    });

    const written = JSON.parse(await readFile(join(targetDir, '.claude.json'), 'utf8')) as Record<string, unknown>;
    expect(written).toMatchObject({ hasCompletedOnboarding: true, targetOwnedSetting: 'kept' });
  });

  it('isolates source root secrets while projecting onboarding completion', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-home-'));
    const sourceDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-source-'));
    const targetDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-target-'));
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'happier-claude-trust-project-'));
    await writeFile(join(sourceDir, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true,
      accessToken: 'must-not-copy',
      refreshToken: 'must-not-copy',
      apiKey: 'must-not-copy',
      nestedSecret: { token: 'must-not-copy' },
      projects: { [sessionDirectory]: { hasTrustDialogAccepted: true } },
    }));

    await materializeClaudeWorkspaceTrust({
      sourceEnv: { CLAUDE_CONFIG_DIR: sourceDir, HOME: homeDir },
      targetDir,
      sessionDirectory,
    });

    const written = JSON.parse(await readFile(join(targetDir, '.claude.json'), 'utf8')) as Record<string, unknown>;
    expect(written.hasCompletedOnboarding).toBe(true);
    expect(written).not.toHaveProperty('accessToken');
    expect(written).not.toHaveProperty('refreshToken');
    expect(written).not.toHaveProperty('apiKey');
    expect(written).not.toHaveProperty('nestedSecret');
  });
});
