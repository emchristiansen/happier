import { readFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';

import { resolveCliTestLaunchSpec, shouldUseCliSourceEntrypoint, type CliTestLaunchSpec } from '../process/cliLaunchSpec';
import { sanitizeCliTestEnv } from '../process/cliTestEnv';
import { runLoggedCommand } from '../process/spawnProcess';
import { repoRootDir } from '../paths';

export type JsonEnvelope = {
  ok: boolean;
  kind: string;
  data?: unknown;
  error?: unknown;
};

function pickLastJsonEnvelope(text: string): JsonEnvelope {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) continue;
    if (!(line.startsWith('{') || line.startsWith('['))) continue;
    try {
      const parsed = JSON.parse(line) as JsonEnvelope;
      if (parsed && typeof parsed === 'object' && typeof parsed.ok === 'boolean' && typeof parsed.kind === 'string') {
        return parsed;
      }
    } catch {
      // keep scanning backwards
    }
  }
  throw new Error(`Failed to parse JSON envelope from CLI stdout: ${JSON.stringify(lines.slice(-20).join('\n'))}`);
}

type CliJsonResolveOptions = Readonly<{
  preferSourceEntrypoint?: boolean;
  skipSourceFreshnessCheck?: boolean;
}>;

/**
 * A CLI JSON-command launch spec resolved ahead of time by `resolveCliJsonLaunchSpec` and lent to
 * `runCliJson`, which then runs it without resolving or preparing anything. It records the testDir
 * and env source-entrypoint selection it was resolved for so a run with a different testDir or
 * entrypoint mode is rejected instead of guessed.
 */
export type PreparedCliJsonLaunchSpec = Readonly<{
  kind: 'cli-json';
  testDir: string;
  cliSourceEntrypointRequested: boolean;
  spec: CliTestLaunchSpec;
}>;

function resolveCliJsonLaunchSpecFresh(
  testDir: string,
  sanitizedEnv: NodeJS.ProcessEnv,
  launchOptions: CliJsonResolveOptions | undefined,
): Promise<CliTestLaunchSpec> {
  return resolveCliTestLaunchSpec(
    { testDir, env: sanitizedEnv },
    {
      snapshotDir: resolvePath(join(testDir, 'cli-dist')),
      preferSourceEntrypoint: launchOptions?.preferSourceEntrypoint,
      skipSourceFreshnessCheck: launchOptions?.skipSourceFreshnessCheck,
    },
  );
}

/**
 * Resolves exactly the launch spec `runCliJson` would resolve for the same testDir, env and resolve
 * options (same sanitization, namespace and mode), for a caller that prepares it once outside a test
 * budget and lends it through `preparedCliLaunchSpec`.
 */
export async function resolveCliJsonLaunchSpec(params: Readonly<{
  testDir: string;
  env: NodeJS.ProcessEnv;
  launchOptions?: CliJsonResolveOptions;
}>): Promise<PreparedCliJsonLaunchSpec> {
  const sanitizedEnv = sanitizeCliTestEnv(params.env);
  const spec = await resolveCliJsonLaunchSpecFresh(params.testDir, sanitizedEnv, params.launchOptions);
  return Object.freeze({
    kind: 'cli-json' as const,
    testDir: resolvePath(params.testDir),
    cliSourceEntrypointRequested: shouldUseCliSourceEntrypoint(sanitizedEnv),
    spec: Object.freeze({
      ...spec,
      args: Object.freeze([...spec.args]) as string[],
      ...(spec.env ? { env: Object.freeze({ ...spec.env }) } : {}),
    }),
  });
}

function assertBorrowableCliJsonLaunchSpec(
  prepared: PreparedCliJsonLaunchSpec,
  testDir: string,
  sanitizedEnv: NodeJS.ProcessEnv,
  launchOptions: CliJsonResolveOptions | undefined,
): void {
  const conflicting = [
    launchOptions?.preferSourceEntrypoint !== undefined ? 'launchOptions.preferSourceEntrypoint' : null,
    launchOptions?.skipSourceFreshnessCheck !== undefined ? 'launchOptions.skipSourceFreshnessCheck' : null,
  ].filter((name): name is string => name !== null);
  if (conflicting.length > 0) {
    throw new Error(
      `runCliJson preparedCliLaunchSpec cannot be combined with ${conflicting.join(', ')}: `
        + 'those options only select how a launch spec is resolved and a borrowed spec is never resolved again; '
        + 'pass them to resolveCliJsonLaunchSpec instead',
    );
  }
  if (prepared.kind !== 'cli-json') {
    throw new Error(`runCliJson preparedCliLaunchSpec must come from resolveCliJsonLaunchSpec (got kind=${String(prepared.kind)})`);
  }
  const resolvedTestDir = resolvePath(testDir);
  const cliSourceEntrypointRequested = shouldUseCliSourceEntrypoint(sanitizedEnv);
  if (prepared.testDir !== resolvedTestDir || prepared.cliSourceEntrypointRequested !== cliSourceEntrypointRequested) {
    throw new Error(
      `runCliJson preparedCliLaunchSpec was resolved for testDir=${prepared.testDir} `
        + `cliSourceEntrypoint=${prepared.cliSourceEntrypointRequested} but this run has testDir=${resolvedTestDir} `
        + `cliSourceEntrypoint=${cliSourceEntrypointRequested}; resolve it with the same testDir and env`,
    );
  }
}

export async function runCliJson(params: Readonly<{
  testDir: string;
  cliHomeDir: string;
  serverUrl: string;
  webappUrl: string;
  env: NodeJS.ProcessEnv;
  label: string;
  args: string[];
  timeoutMs?: number;
  launchOptions?: Readonly<{
    preferSourceEntrypoint?: boolean;
    skipSourceFreshnessCheck?: boolean;
    skipSharedDepsBuild?: boolean;
  }>;
  /** Borrowed launch spec from resolveCliJsonLaunchSpec; run as-is, never resolved again. */
  preparedCliLaunchSpec?: PreparedCliJsonLaunchSpec;
}>): Promise<JsonEnvelope> {
  const sanitizedEnv = sanitizeCliTestEnv(params.env);
  if (params.preparedCliLaunchSpec !== undefined) {
    assertBorrowableCliJsonLaunchSpec(params.preparedCliLaunchSpec, params.testDir, sanitizedEnv, params.launchOptions);
  }
  const cliLaunchSpec = params.preparedCliLaunchSpec !== undefined
    ? params.preparedCliLaunchSpec.spec
    : await resolveCliJsonLaunchSpecFresh(params.testDir, sanitizedEnv, params.launchOptions);
  const stdoutPath = resolvePath(join(params.testDir, `cli.${params.label}.stdout.log`));
  const stderrPath = resolvePath(join(params.testDir, `cli.${params.label}.stderr.log`));
  const env = {
    ...sanitizedEnv,
    ...(params.launchOptions?.skipSharedDepsBuild
      ? {
          HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
        }
      : {}),
  };

  await runLoggedCommand({
    command: cliLaunchSpec.command,
    args: [...cliLaunchSpec.args, ...params.args],
    cwd: repoRootDir(),
    env: {
      ...env,
      ...(cliLaunchSpec.env ?? {}),
      CI: '1',
      HAPPIER_SESSION_AUTOSTART_DAEMON: '0',
      HAPPIER_HOME_DIR: params.cliHomeDir,
      HAPPIER_SERVER_URL: params.serverUrl,
      HAPPIER_WEBAPP_URL: params.webappUrl,
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_VARIANT: 'dev',
    },
    stdoutPath,
    stderrPath,
    timeoutMs: params.timeoutMs,
  });

  const stdoutText = await readFile(stdoutPath, 'utf8').catch(() => '');
  return pickLastJsonEnvelope(stdoutText);
}
