import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveOpenCodeManagedServerChildEnv } from '@/backends/opencode/server/openCodeManagedServerEnv';

import {
  buildOpenCodeV2BrokerConfigContent,
  ensureOpenCodeBrokerPluginAssets,
  prepareOpenCodeConnectedAuthAssets,
  resolveOpenCodeBrokerPluginDir,
  resolveOpenCodeBrokerPluginPath,
  resolveOpenCodeV2BrokerPluginPath,
  resolveOpenCodeV2BrokerPluginSourcePath,
  resolveOpenCodeConnectedConfigHomeDir,
} from './openCodeBrokerPluginAssets';

describe('openCodeBrokerPluginAssets', () => {
  it('writes broker plugin file(s) for brokered providers and creates the connected config home (idempotent)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-broker-assets-'));
    await ensureOpenCodeBrokerPluginAssets({ providers: ['openai', 'anthropic'], happyHomeDir: home });

    const configHome = resolveOpenCodeConnectedConfigHomeDir(home);
    expect((await stat(configHome)).isDirectory()).toBe(true);

    const openaiPath = resolveOpenCodeBrokerPluginPath('openai', home);
    const anthropicPath = resolveOpenCodeBrokerPluginPath('anthropic', home);
    const openaiSource = await readFile(openaiPath, 'utf8');
    expect(openaiSource).toContain('HappierOpenCodeAuthBrokerPlugin');
    expect(openaiSource).toContain('chatgpt.com/backend-api');
    expect(await readFile(anthropicPath, 'utf8')).toContain('oauth-2025-04-20');

    // Idempotent: a second call with no change does not throw.
    await ensureOpenCodeBrokerPluginAssets({ providers: ['openai', 'anthropic'], happyHomeDir: home });
  });

  it('materializes V2 plugins outside the auto-load directory used by V1', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-broker-assets-v2-'));
    await ensureOpenCodeBrokerPluginAssets({ providers: ['openai'], apiGeneration: 'v2', happyHomeDir: home });

    const v2Path = resolveOpenCodeV2BrokerPluginPath('openai', home);
    const v2SourcePath = resolveOpenCodeV2BrokerPluginSourcePath('openai', home);
    expect((await stat(v2Path)).isDirectory()).toBe(true);
    await expect(readFile(v2SourcePath, 'utf8')).resolves.toContain('id: "happier-broker-" + PROVIDER');
    expect(dirname(v2SourcePath)).toBe(v2Path);
    expect(v2Path).not.toBe(resolveOpenCodeBrokerPluginDir(home));
    await expect(stat(resolveOpenCodeBrokerPluginPath('openai', home))).rejects.toBeTruthy();
  });

  it('prepares the same selected broker assets and composed config for every V2 caller', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-broker-assets-prepare-'));
    const prepared = await prepareOpenCodeConnectedAuthAssets({
      env: {
        HAPPIER_OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY: 'opencode|connected|openai-codex:primary:',
        HAPPIER_OPENCODE_BROKER_SELECTIONS: JSON.stringify({
          openai: {
            serviceId: 'openai-codex',
            profileId: 'primary',
            accountId: 'acct_1',
            planType: 'plus',
          },
        }),
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          providers: { anthropic: { settings: { apiKey: 'direct-key' } } },
          share: 'disabled',
        }),
      },
      apiGeneration: 'v2',
      happyHomeDir: home,
    });

    expect(prepared.providers).toEqual(['openai']);
    expect(JSON.parse(prepared.openCodeConfigContent ?? '{}')).toEqual({
      providers: {
        openai: {},
        anthropic: { settings: { apiKey: 'direct-key' } },
      },
      share: 'disabled',
      plugins: [resolveOpenCodeV2BrokerPluginPath('openai', home)],
    });
    await expect(readFile(resolveOpenCodeV2BrokerPluginSourcePath('openai', home), 'utf8'))
      .resolves.toContain('model.request');
  });

  it('composes legacy and native plugin arrays without admitting an unselected broker', () => {
    expect(JSON.parse(buildOpenCodeV2BrokerConfigContent(
      ['anthropic'],
      JSON.stringify({ plugin: ['legacy'], plugins: ['native'] }),
      '/happier-home',
    ))).toEqual({
      providers: { anthropic: {} },
      plugins: [
        'legacy',
        'native',
        resolveOpenCodeV2BrokerPluginPath('anthropic', '/happier-home'),
      ],
    });
  });

  it('retires versioned Happier broker siblings while preserving unrelated plugins', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-broker-assets-retire-'));
    const pluginDir = join(resolveOpenCodeConnectedConfigHomeDir(home), 'opencode', 'plugin');
    await mkdir(pluginDir, { recursive: true });
    await Promise.all([
      writeFile(join(pluginDir, 'happier-broker-openai-1.js'), 'stale v1', 'utf8'),
      writeFile(join(pluginDir, 'happier-broker-openai-2.js'), 'stale v2', 'utf8'),
      writeFile(join(pluginDir, 'unrelated-plugin.js'), 'unrelated', 'utf8'),
    ]);

    await ensureOpenCodeBrokerPluginAssets({ providers: ['openai'], happyHomeDir: home });

    expect((await readdir(pluginDir)).sort()).toEqual([
      'happier-broker-openai.js',
      'unrelated-plugin.js',
    ]);
    await expect(readFile(resolveOpenCodeBrokerPluginPath('openai', home), 'utf8'))
      .resolves.toContain('HappierOpenCodeAuthBrokerPlugin');
  });

  it('places the broker plugin in the connected config home auto-load dir with a .js extension (OpenCode globs *.js only, not *.mjs)', () => {
    // Live-verified (opencode v1.14.41): plugin auto-discovery scans <XDG_CONFIG_HOME>/opencode/plugin/
    // and matches *.js ONLY — *.mjs files are silently ignored, and OPENCODE_CONFIG_CONTENT.plugin does
    // not load an absolute path. So the broker MUST be a .js file inside the connected config home's
    // opencode/plugin/ auto-load dir (XDG_CONFIG_HOME already points at the connected config home).
    const home = '/happier-home';
    const configHome = resolveOpenCodeConnectedConfigHomeDir(home);
    const openaiPath = resolveOpenCodeBrokerPluginPath('openai', home);

    expect(openaiPath.endsWith('.js')).toBe(true);
    expect(openaiPath.endsWith('.mjs')).toBe(false);
    // Must live UNDER the connected config home (so the redirected XDG_CONFIG_HOME auto-loads it)…
    expect(openaiPath.startsWith(configHome + '/')).toBe(true);
    // …specifically in the opencode/plugin/ auto-load dir.
    expect(openaiPath.includes('/opencode/plugin/')).toBe(true);
  });

  it('creates only the empty config home when no provider is brokered (direct-API-key connected session)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-broker-assets-empty-'));
    await ensureOpenCodeBrokerPluginAssets({ providers: [], happyHomeDir: home });
    expect((await stat(resolveOpenCodeConnectedConfigHomeDir(home)).then((s) => s.isDirectory()).catch(() => false))).toBe(true);
    await expect(stat(resolveOpenCodeBrokerPluginPath('openai', home))).rejects.toBeTruthy();
  });

  it('config isolation: a NATIVE child env keeps the user XDG_CONFIG_HOME; a CONNECTED child env gets the Happier-owned one', () => {
    // Native: no Happier auth/config injected ⇒ the user's own XDG_CONFIG_HOME passes through unchanged.
    const nativeEnv = resolveOpenCodeManagedServerChildEnv({
      baseEnv: { HOME: '/home/u', XDG_CONFIG_HOME: '/home/u/.config' } as NodeJS.ProcessEnv,
      xdgRootDir: null,
      isolateConfig: false,
    });
    expect(nativeEnv.XDG_CONFIG_HOME).toBe('/home/u/.config');

    // Connected: the materializer's Happier-owned config home survives into the managed-server env.
    const connectedConfigHome = '/happier/opencode/connected-config';
    const connectedEnv = resolveOpenCodeManagedServerChildEnv({
      baseEnv: { HOME: '/home/u', XDG_CONFIG_HOME: connectedConfigHome, OPENCODE_AUTH_CONTENT: '{"openai":{"type":"api","key":"happier-broker:openai:1"}}' } as NodeJS.ProcessEnv,
      xdgRootDir: null,
      isolateConfig: false,
    });
    expect(connectedEnv.XDG_CONFIG_HOME).toBe(connectedConfigHome);
  });
});
