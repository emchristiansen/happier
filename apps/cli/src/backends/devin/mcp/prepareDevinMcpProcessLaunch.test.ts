import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';

const { createAbsolutePathSymlinkMock } = vi.hoisted(() => ({
  createAbsolutePathSymlinkMock: vi.fn(),
}));

vi.mock('@/utils/fs/createAbsolutePathSymlink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/fs/createAbsolutePathSymlink')>();
  createAbsolutePathSymlinkMock.mockImplementation(actual.createAbsolutePathSymlink);
  return { ...actual, createAbsolutePathSymlink: createAbsolutePathSymlinkMock };
});

import {
  prepareDevinMcpProcessLaunch,
  resolveDevinConfigPaths,
  resolveDevinProjectConfigDirectories,
} from './prepareDevinMcpProcessLaunch';

describe('prepareDevinMcpProcessLaunch', () => {
  beforeEach(() => {
    createAbsolutePathSymlinkMock.mockClear();
  });

  it('leaves the native Devin environment untouched when there are no session MCP servers', async () => {
    await withTempDir('happier-devin-no-session-mcp-', async (cwd) => {
      const configRoot = join(cwd, 'config');
      await mkdir(join(configRoot, 'devin'), { recursive: true });
      await writeFile(join(configRoot, 'devin', 'mcp_config.json'), '{native-validation-is-not-ours', 'utf8');
      const prepared = await prepareDevinMcpProcessLaunch({
        cwd,
        processEnv: { XDG_CONFIG_HOME: configRoot },
        mcpServers: {},
      });

      expect(prepared.env).toEqual({});
      await prepared.cleanup();
    });
  });

  it('merges user and session MCP servers into an isolated Devin config and restores child XDG config', async () => {
    await withTempDir('happier-devin-user-config-', async (userConfigRoot) => {
      const sourcePaths = resolveDevinConfigPaths({
        HOME: join(userConfigRoot, 'home'),
        XDG_CONFIG_HOME: userConfigRoot,
      });
      await mkdir(sourcePaths.devinConfigDir, { recursive: true });
      await mkdir(join(sourcePaths.devinConfigDir, 'skills', 'native-skill'), { recursive: true });
      await mkdir(join(sourcePaths.configRoot, 'cognition', 'skills', 'legacy-skill'), { recursive: true });
      await writeFile(sourcePaths.mainConfigPath, '{"theme":"dark"}', 'utf8');
      await writeFile(
        join(sourcePaths.devinConfigDir, 'skills', 'native-skill', 'SKILL.md'),
        '# Native skill\n',
        'utf8',
      );
      await writeFile(
        join(sourcePaths.configRoot, 'cognition', 'skills', 'legacy-skill', 'SKILL.md'),
        '# Legacy skill\n',
        'utf8',
      );
      await writeFile(sourcePaths.mcpConfigPath, JSON.stringify({
        untouched: { enabled: true },
        mcpServers: {
          native: {
            command: 'native-mcp',
            args: ['serve'],
            env: { NATIVE_SECRET: 'secret' },
            transport: 'stdio',
          },
          collision: { command: 'old-command', transport: 'stdio' },
          remote: { url: 'https://example.test/mcp', transport: 'http' },
        },
      }), 'utf8');

      const prepared = await prepareDevinMcpProcessLaunch({
        cwd: userConfigRoot,
        processEnv: {
          HOME: join(userConfigRoot, 'home'),
          XDG_CONFIG_HOME: userConfigRoot,
        },
        mcpServers: {
          collision: { command: 'happier-mcp', args: ['bridge'] },
          explicitXdg: {
            command: 'custom-mcp',
            env: { XDG_CONFIG_HOME: '/custom/mcp/config' },
          },
        },
      });

      try {
        expect(prepared.env.XDG_CONFIG_HOME).not.toBe(userConfigRoot);
        expect(await readFile(join(prepared.env.XDG_CONFIG_HOME, 'devin', 'config.json'), 'utf8'))
          .toBe('{"theme":"dark"}');
        expect((await lstat(join(prepared.env.XDG_CONFIG_HOME, 'devin', 'config.json'))).isSymbolicLink())
          .toBe(true);
        expect((await lstat(join(prepared.env.XDG_CONFIG_HOME, 'devin', 'skills'))).isSymbolicLink())
          .toBe(true);
        expect((await lstat(join(prepared.env.XDG_CONFIG_HOME, 'cognition'))).isSymbolicLink())
          .toBe(true);
        expect(await readFile(
          join(prepared.env.XDG_CONFIG_HOME, 'devin', 'skills', 'native-skill', 'SKILL.md'),
          'utf8',
        )).toBe('# Native skill\n');
        expect(await readFile(
          join(prepared.env.XDG_CONFIG_HOME, 'cognition', 'skills', 'legacy-skill', 'SKILL.md'),
          'utf8',
        )).toBe('# Legacy skill\n');
        const overlayPath = join(prepared.env.XDG_CONFIG_HOME, 'devin', 'mcp_config.json');
        const overlay = JSON.parse(await readFile(overlayPath, 'utf8'));

        expect(overlay.untouched).toEqual({ enabled: true });
        expect(overlay.mcpServers.remote).toEqual({
          url: 'https://example.test/mcp',
          transport: 'http',
        });
        expect(overlay.mcpServers.native).toEqual({
          command: 'native-mcp',
          args: ['serve'],
          env: {
            XDG_CONFIG_HOME: userConfigRoot,
            NATIVE_SECRET: 'secret',
          },
          transport: 'stdio',
        });
        expect(overlay.mcpServers.collision).toEqual({
          command: 'happier-mcp',
          args: ['bridge'],
          env: { XDG_CONFIG_HOME: userConfigRoot },
          transport: 'stdio',
        });
        expect(overlay.mcpServers.explicitXdg.env.XDG_CONFIG_HOME).toBe('/custom/mcp/config');

        expect(JSON.parse(await readFile(sourcePaths.mcpConfigPath, 'utf8')).mcpServers.collision.command)
          .toBe('old-command');
      } finally {
        await prepared.cleanup();
      }

      expect(existsSync(prepared.env.XDG_CONFIG_HOME)).toBe(false);
      expect(await readFile(
        join(sourcePaths.devinConfigDir, 'skills', 'native-skill', 'SKILL.md'),
        'utf8',
      )).toBe('# Native skill\n');
      expect(await readFile(
        join(sourcePaths.configRoot, 'cognition', 'skills', 'legacy-skill', 'SKILL.md'),
        'utf8',
      )).toBe('# Legacy skill\n');
    });
  });

  it('fails loudly when the user MCP config is malformed', async () => {
    await withTempDir('happier-devin-user-config-', async (userConfigRoot) => {
      const paths = resolveDevinConfigPaths({ HOME: userConfigRoot, XDG_CONFIG_HOME: userConfigRoot });
      await mkdir(paths.devinConfigDir, { recursive: true });
      await writeFile(paths.mcpConfigPath, '{not-json', 'utf8');

      await expect(prepareDevinMcpProcessLaunch({
        cwd: userConfigRoot,
        processEnv: { HOME: userConfigRoot, XDG_CONFIG_HOME: userConfigRoot },
        mcpServers: { happier: { command: 'happier-mcp' } },
      })).rejects.toThrow(/Devin MCP config/);
    });
  });

  it('fails closed instead of copying provider state when linking is unavailable', async () => {
    await withTempDir('happier-devin-link-failure-', async (root) => {
      const paths = resolveDevinConfigPaths({ HOME: root, XDG_CONFIG_HOME: root });
      await mkdir(paths.devinConfigDir, { recursive: true });
      await writeFile(paths.mainConfigPath, '{"theme":"dark"}', 'utf8');
      createAbsolutePathSymlinkMock.mockRejectedValueOnce(new Error('link unavailable'));

      await expect(prepareDevinMcpProcessLaunch({
        cwd: root,
        processEnv: { HOME: root, XDG_CONFIG_HOME: root },
        mcpServers: { happier: { command: 'happier-mcp' } },
      })).rejects.toThrow('link unavailable');
    });
  });

  it('fails loudly when a higher-priority project config shadows a session MCP server', async () => {
    await withTempDir('happier-devin-project-config-', async (projectRoot) => {
      await mkdir(join(projectRoot, '.git'), { recursive: true });
      await mkdir(join(projectRoot, '.devin'), { recursive: true });
      await writeFile(join(projectRoot, '.devin', 'mcp_config.json'), JSON.stringify({
        mcpServers: { happier: { command: 'workspace-controlled-command' } },
      }), 'utf8');

      await expect(prepareDevinMcpProcessLaunch({
        cwd: projectRoot,
        processEnv: { HOME: projectRoot, XDG_CONFIG_HOME: join(projectRoot, 'user-config') },
        mcpServers: { happier: { command: 'trusted-happier-mcp' } },
      })).rejects.toThrow(/shadows the session MCP server 'happier'/);
    });
  });

  it('treats the working directory as the project root when no VCS root exists', async () => {
    await expect(resolveDevinProjectConfigDirectories('/standalone/project', async () => false))
      .resolves.toEqual([resolve('/standalone/project')]);
  });

  it('uses APPDATA for the Devin config overlay and MCP child restoration on Windows', async () => {
    await withTempDir('happier-devin-windows-config-', async (appDataRoot) => {
      const paths = resolveDevinConfigPaths({
        APPDATA: appDataRoot,
        USERPROFILE: join(appDataRoot, 'home'),
        XDG_CONFIG_HOME: join(appDataRoot, 'ignored-xdg'),
      }, 'win32');
      expect(paths.configRoot).toBe(appDataRoot);
      await mkdir(paths.devinConfigDir, { recursive: true });

      const prepared = await prepareDevinMcpProcessLaunch({
        cwd: appDataRoot,
        platform: 'win32',
        processEnv: {
          APPDATA: appDataRoot,
          USERPROFILE: join(appDataRoot, 'home'),
          XDG_CONFIG_HOME: join(appDataRoot, 'ignored-xdg'),
        },
        mcpServers: { happier: { command: 'happier-mcp' } },
      });
      try {
        expect(prepared.env).toEqual({ APPDATA: expect.stringContaining('happier-devin-acp-') });
        const overlay = JSON.parse(await readFile(join(prepared.env.APPDATA, 'devin', 'mcp_config.json'), 'utf8'));
        expect(overlay.mcpServers.happier.env).toEqual({ APPDATA: appDataRoot });
      } finally {
        await prepared.cleanup();
      }
    });
  });
});
