import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { configuration } from '@/configuration';
import { writeGeneratedTextAtomicallyIfChanged } from '@/utils/fs/writeGeneratedTextAtomicallyIfChanged';

import {
  OPEN_CODE_BROKER_PROVIDERS,
  OPEN_CODE_BROKER_SELECTION_IDENTITY_ENV,
  OPEN_CODE_BROKER_SELECTIONS_ENV,
  parseOpenCodeBrokerSelections,
  type OpenCodeBrokerProvider,
} from './openCodeBrokerPluginEnv';
import {
  buildOpenCodeBrokerPluginSource,
  buildOpenCodeBrokerV2PluginSource,
} from './openCodeBrokerPluginSource';

/**
 * Deterministic on-disk paths for the broker assets. They are derived purely from `happyHomeDir`
 * (a stable singleton) + provider, so:
 *  - the materializer can REFERENCE the paths without any filesystem I/O (keeping it pure +
 *    overlay-safe for fingerprint computation), and
 *  - the server-launch path can WRITE the assets idempotently (live spawn only).
 *
 * The filename is intentionally not versioned. OpenCode auto-loads every `.js` file in this
 * directory, so versioned siblings would be competing live plugins rather than compatibility.
 */

/** Happier-owned, isolated OpenCode config home for connected sessions (no user 3rd-party plugins). */
export function resolveOpenCodeConnectedConfigHomeDir(happyHomeDir: string = configuration.happyHomeDir): string {
  return join(happyHomeDir, 'opencode', 'connected-config');
}

/**
 * OpenCode's plugin auto-discovery dir, RELATIVE TO the (redirected) `XDG_CONFIG_HOME`. Live-verified
 * against opencode v1.14.41: it scans `<XDG_CONFIG_HOME>/opencode/plugin/` (and `plugins/`) and loads
 * each plugin file from there. The broker plugin lives here so that pointing `XDG_CONFIG_HOME` at the
 * connected config home (config isolation) is sufficient for V1 to load it — V1 needs no
 * `OPENCODE_CONFIG_CONTENT` registration and does not load an absolute `config.plugin` path. The
 * V2 managed-server owner explicitly registers a separate generated path through `config.plugin`.
 */
export function resolveOpenCodeBrokerPluginDir(happyHomeDir: string = configuration.happyHomeDir): string {
  return join(resolveOpenCodeConnectedConfigHomeDir(happyHomeDir), 'opencode', 'plugin');
}

export function resolveOpenCodeBrokerPluginPath(
  provider: OpenCodeBrokerProvider,
  happyHomeDir: string = configuration.happyHomeDir,
): string {
  // MUST be `.js`: opencode v1.14.41's plugin auto-discovery globs `*.js` ONLY and ignores `*.mjs`
  // (live-verified head-to-head in the same dir). A `.mjs` broker file is silently never loaded.
  return join(resolveOpenCodeBrokerPluginDir(happyHomeDir), `happier-broker-${provider}.js`);
}

export function resolveOpenCodeV2BrokerPluginPath(
  provider: OpenCodeBrokerProvider,
  happyHomeDir: string = configuration.happyHomeDir,
): string {
  // Released V2 accepts configured local plugins as directories (a configured absolute file is
  // rejected by its ConfigPluginSource owner). Keep each entrypoint in its own directory outside
  // automatic discovery so one generated module cannot be installed twice in the same process.
  return join(resolveOpenCodeConnectedConfigHomeDir(happyHomeDir), 'happier-v2-plugins', `happier-broker-${provider}`);
}

export function resolveOpenCodeV2BrokerPluginSourcePath(
  provider: OpenCodeBrokerProvider,
  happyHomeDir: string = configuration.happyHomeDir,
): string {
  return join(resolveOpenCodeV2BrokerPluginPath(provider, happyHomeDir), 'index.js');
}

export function buildOpenCodeV2BrokerConfigContent(
  providers: readonly OpenCodeBrokerProvider[],
  baseContent?: string,
  happyHomeDir: string = configuration.happyHomeDir,
): string {
  const parsed = typeof baseContent === 'string' && baseContent.trim().length > 0
    ? JSON.parse(baseContent) as unknown
    : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OpenCode config content must be a JSON object');
  }
  const config = { ...(parsed as Record<string, unknown>) };
  const legacyPlugins = Array.isArray(config.plugin) ? config.plugin : [];
  const nativePlugins = Array.isArray(config.plugins) ? config.plugins : [];
  const configuredProviders = config.providers && typeof config.providers === 'object' && !Array.isArray(config.providers)
    ? config.providers as Record<string, unknown>
    : {};
  delete config.plugin;
  return JSON.stringify({
    ...config,
    providers: {
      ...configuredProviders,
      ...Object.fromEntries(providers
        .filter((provider) => configuredProviders[provider] === undefined)
        .map((provider) => [provider, {}])),
    },
    plugins: [
      ...legacyPlugins,
      ...nativePlugins,
      ...providers.map((provider) => resolveOpenCodeV2BrokerPluginPath(provider, happyHomeDir)),
    ],
  });
}

const VERSIONED_OPEN_CODE_BROKER_PLUGIN_PATTERN =
  /^happier-broker-(?:openai|anthropic)-[^/]+\.js$/u;

async function retireVersionedOpenCodeBrokerPluginAssets(pluginDir: string): Promise<void> {
  const entries = await readdir(pluginDir, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  await Promise.all(entries
    .filter((entry) => (
      entry.isFile()
      && VERSIONED_OPEN_CODE_BROKER_PLUGIN_PATTERN.test(entry.name)
    ))
    .map((entry) => rm(join(pluginDir, entry.name), { force: true })));
}

/**
 * Idempotently materialize the broker assets for the given providers:
 *  - ensure the Happier-owned connected config home exists (isolated ⇒ no user 3rd-party plugins), and
 *  - write each provider's self-contained broker plugin `.js` file into the config home's
 *    `opencode/plugin/` auto-load dir so OpenCode discovers + loads it from the redirected
 *    `XDG_CONFIG_HOME` (live-verified V1 mechanism; `.mjs` + `OPENCODE_CONFIG_CONTENT.plugin` do not load).
 *
 * Safe to call repeatedly (write-if-changed). Called from the live server-launch path only.
 */
export async function ensureOpenCodeBrokerPluginAssets(params: Readonly<{
  providers: readonly OpenCodeBrokerProvider[];
  apiGeneration?: 'v1' | 'v2';
  happyHomeDir?: string;
}>): Promise<void> {
  const happyHomeDir = params.happyHomeDir ?? configuration.happyHomeDir;
  await mkdir(resolveOpenCodeConnectedConfigHomeDir(happyHomeDir), { recursive: true });
  const providers = params.providers.filter((provider) => OPEN_CODE_BROKER_PROVIDERS.includes(provider));
  const pluginDir = resolveOpenCodeBrokerPluginDir(happyHomeDir);
  await mkdir(pluginDir, { recursive: true });
  await retireVersionedOpenCodeBrokerPluginAssets(pluginDir);
  if (providers.length === 0) return;
  if (params.apiGeneration === 'v2') {
    await mkdir(join(resolveOpenCodeConnectedConfigHomeDir(happyHomeDir), 'happier-v2-plugins'), { recursive: true });
  }
  await Promise.all(providers.map(async (provider) => {
    const isV2 = params.apiGeneration === 'v2';
    const path = isV2
      ? resolveOpenCodeV2BrokerPluginSourcePath(provider, happyHomeDir)
      : resolveOpenCodeBrokerPluginPath(provider, happyHomeDir);
    if (isV2) await mkdir(resolveOpenCodeV2BrokerPluginPath(provider, happyHomeDir), { recursive: true });
    await writeGeneratedTextAtomicallyIfChanged({
      path,
      contents: isV2
        ? buildOpenCodeBrokerV2PluginSource(provider)
        : buildOpenCodeBrokerPluginSource(provider),
      mode: 0o600,
    });
  }));
}

/**
 * Canonical preparation boundary shared by every process that launches OpenCode with connected
 * auth (managed server and catalog preflight). It writes only selected broker providers and
 * composes their V2 registrations over the already-materialized direct-provider config.
 */
export async function prepareOpenCodeConnectedAuthAssets(params: Readonly<{
  env: NodeJS.ProcessEnv;
  apiGeneration: 'auto' | 'v2';
  happyHomeDir?: string;
}>): Promise<Readonly<{
  providers: readonly OpenCodeBrokerProvider[];
  openCodeConfigContent?: string;
}>> {
  if (typeof params.env[OPEN_CODE_BROKER_SELECTION_IDENTITY_ENV] !== 'string') {
    return { providers: [] };
  }
  const selections = parseOpenCodeBrokerSelections(params.env[OPEN_CODE_BROKER_SELECTIONS_ENV]);
  const providers = OPEN_CODE_BROKER_PROVIDERS.filter((provider) => selections[provider]);
  const happyHomeDir = params.happyHomeDir ?? configuration.happyHomeDir;
  if (params.apiGeneration === 'auto') {
    await Promise.all([
      ensureOpenCodeBrokerPluginAssets({ providers, apiGeneration: 'v1', happyHomeDir }),
      ensureOpenCodeBrokerPluginAssets({ providers, apiGeneration: 'v2', happyHomeDir }),
    ]);
  } else {
    await ensureOpenCodeBrokerPluginAssets({ providers, apiGeneration: 'v2', happyHomeDir });
  }
  return {
    providers,
    ...(providers.length > 0 ? {
      openCodeConfigContent: buildOpenCodeV2BrokerConfigContent(
        providers,
        params.env.OPENCODE_CONFIG_CONTENT,
        happyHomeDir,
      ),
    } : {}),
  };
}
