import chalk from 'chalk';
import { readCredentials } from '@/persistence';
import { ApiClient } from '@/api/api';
import type { CloudConnectTarget, CloudConnectTargetStatus } from '@/cloud/connectTypes';
import { AGENTS } from '@/backends/catalog';
import { promptInput } from '@/terminal/prompts/promptInput';
import { buildConnectedServiceCredentialRecord, supportsConnectedServiceOperation, type ConnectedServiceId } from '@happier-dev/protocol';

import type { CommandContext } from '@/cli/commandRegistry';
import { buildConnectedAccountOauthCredentialRecord } from '@/daemon/connectedServices/descriptors/buildConnectedAccountCredentialRecord';
import { githubConnectedAccountTarget } from '@/daemon/connectedServices/github/githubConnectedAccountTarget';
import { parseConnectArgs, type ConnectParsedOptions } from './connect/parseConnectArgs';
import { formatConnectStatusLines, type ConnectStatusServiceListing, type ConnectStatusVendor } from './connect/formatConnectStatus';
import { resolveConnectAuthIntent } from './connect/resolveConnectAuthIntent';
import { resolveConnectTargetServiceIds } from './connect/resolveConnectTargetServiceIds';
import { storeConnectedServiceCredentialForAccount } from '@/cloud/connectedServices/storeConnectedServiceCredentialForAccount';
import { runConnectedServiceImport } from '@/cloud/connectedServices/connectedServiceImport';
import { observeServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { fail, info, neutral, ok, sectionTitle, warn } from '@happier-dev/cli-common/output';

/**
 * Handle connect subcommand.
 *
 * Implements connect subcommands for storing Connected Services credentials (v2):
 * - connect codex: Store OpenAI Codex subscription OAuth (openai-codex) or OpenAI API key (openai)
 * - connect claude: Store Claude subscription auth (claude-subscription) or Anthropic API key (anthropic)
 * - connect gemini: Store Gemini OAuth (gemini)
 */
export async function handleConnectCommand(args: string[]): Promise<void> {
    const { includeExperimental, subcommand, profileFlag, options } = parseConnectArgs(args);

    const allTargets = await loadConnectTargets({ includeExperimental: true });
    const visibleTargets = includeExperimental ? allTargets : allTargets.filter((t) => t.status === 'wired');

    const targetById = new Map<string, CloudConnectTarget>(allTargets.flatMap((target) =>
      [target.id, ...target.aliases ?? []].map((name) => [name.toLowerCase(), target] as const),
    ));

    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        showConnectHelp(visibleTargets, { includeExperimental });
        return;
    }

    const normalized = subcommand.toLowerCase();
    if (normalized === 'status') {
      if (profileFlag.kind === 'missing_value') {
        console.error(chalk.red('Missing value for --profile.'));
        console.error('Usage: happier connect status --profile <id>');
        process.exit(1);
      }
      await handleConnectStatus(visibleTargets, {
        profileFilter: profileFlag.kind === 'value' ? profileFlag.profileId : null,
      });
      return;
    }

    const target = targetById.get(normalized);
    const visibleTarget = target && (includeExperimental || target.status === 'wired') ? target : undefined;
    if (!visibleTarget) {
      const hiddenTarget = target;
      if (hiddenTarget && hiddenTarget.status === 'experimental' && !includeExperimental) {
        console.error(chalk.yellow(`Connect target '${hiddenTarget.id}' is experimental and not enabled by default.`));
        console.error(chalk.gray(`Run: happier connect --all ${hiddenTarget.id}`));
        process.exit(1);
      }
      console.error(chalk.red(`Unknown connect target: ${subcommand}`));
      showConnectHelp(visibleTargets, { includeExperimental });
      process.exit(1);
    }

    await handleConnectVendor(visibleTarget, options);
}

async function loadConnectTargets(params: Readonly<{ includeExperimental: boolean }>): Promise<CloudConnectTarget[]> {
  const targets: CloudConnectTarget[] = [githubConnectedAccountTarget];
  for (const entry of Object.values(AGENTS)) {
    if (!entry.getCloudConnectTarget) continue;
    targets.push(await entry.getCloudConnectTarget());
  }
  targets.sort((a, b) => a.id.localeCompare(b.id));
  return params.includeExperimental ? targets : targets.filter((t) => t.status === 'wired');
}

function showConnectHelp(targets: ReadonlyArray<CloudConnectTarget>, opts: Readonly<{ includeExperimental: boolean }>): void {
    const targetLines = targets.length > 0
      ? targets.map((t) => formatTargetLine(t)).join('\n')
      : '  (no connect targets registered)';
    console.log(`
${chalk.bold('happier connect')} - Connect AI vendor subscriptions and API keys to Happier cloud

${chalk.bold('Usage:')}
${targetLines}
  happier connect status       Show every stored profile and its health, per vendor
  happier connect status --profile <id>        Show only profiles with this id
  happier connect help         Show this help message
  happier connect --all ...    Include experimental providers
  happier connect <target> --profile <id>      Store under a specific profile (default: default)
  happier connect <target> --import --source <id>  Import a native login on this machine
  happier connect <target> --paste             Headless mode: paste redirect URL
  happier connect <target> --device            Use device-code auth (Codex)
  happier connect codex --api-key              Store an OpenAI API key
  happier connect claude --api-key             Store an Anthropic API key (not Claude subscription)
  happier connect claude --setup-token         Store a Claude setup-token (default for claude)
  happier connect claude --oauth               Store Claude subscription OAuth (advanced)
  happier connect github --token               Store a GitHub access token
  happier connect <target> --no-open           Do not attempt to open a browser
  happier connect <target> --timeout <seconds> Override OAuth timeout

${chalk.bold('Description:')}
  The connect command allows you to securely store your connected-service credentials
  in Happier cloud. This enables you to use these services through Happier
  without exposing credentials locally.

${chalk.bold('Examples:')}
  happier connect ${targets[0]?.id ?? 'gemini'}
  happier connect status
  happier connect status --profile work

${chalk.bold('Notes:')} 
  • You must be authenticated with Happier first (run 'happier auth login')
  • Credentials are encrypted and stored securely in Happier cloud
  • You can manage your stored keys at cloud.happier.dev
  ${opts.includeExperimental ? '' : '• Some providers are experimental; use --all to show them'}
`);
}

function formatTargetLine(target: CloudConnectTarget): string {
  const statusSuffix = target.status === 'wired' ? '' : chalk.gray(' (experimental)');
  return `  happier connect ${target.id.padEnd(12)} ${target.vendorDisplayName}${statusSuffix}`;
}

async function handleConnectVendor(target: CloudConnectTarget, options: ConnectParsedOptions): Promise<void> {
    console.log(`\n${sectionTitle(`Connecting ${target.vendorDisplayName} to Happier cloud`)}\n`);

    // Check if authenticated
    const credentials = await readCredentials();
    if (!credentials) {
        console.log(warn('Not authenticated with Happier'));
        console.log(chalk.gray('  Please run "happier auth login" first'));
        process.exit(1);
    }

    // Create API client
    const api = await ApiClient.create(credentials);

    if (options.import) {
      if (!target.importServiceId) {
        throw Object.assign(new Error('This provider does not declare native credential import.'), { code: 'unsupported' });
      }
      const account = { api, credentials };
      const discovery = await runConnectedServiceImport({ request: { op: 'discover', serviceId: target.importServiceId }, account });
      if (!discovery.ok) throw Object.assign(new Error(discovery.error), { code: discovery.errorCode });
      if (discovery.op !== 'discover') throw new Error('Unexpected native import discovery result.');
      const source = options.source ?? (discovery.sources.length === 1 ? discovery.sources[0]?.id : null);
      if (!source) throw Object.assign(new Error(`Choose a native source with --source (${discovery.sources.map((candidate) => candidate.id).join(', ')}).`), { code: 'unsupported_source' });
      const imported = await runConnectedServiceImport({ request: { op: 'import', serviceId: target.importServiceId, profileId: options.profileId, source }, account });
      if (!imported.ok) throw Object.assign(new Error(imported.error), { code: imported.errorCode });
      console.log(ok(`${target.displayName} native login imported into ${options.profileId}`));
      process.exit(0);
    }

    const now = Date.now();
    let postConnectPayload: unknown | null = null;

    const record = await (async () => {
      const authIntent = resolveConnectAuthIntent({ targetId: target.id, options });
      const serviceId: ConnectedServiceId = authIntent.serviceId;
      // Released services remain available on older servers without a probe.
      // New services require admission before acquiring or prompting for credentials.
      if (!supportsConnectedServiceOperation(null, serviceId)) {
        const snapshot = await observeServerFeaturesSnapshot({
          serverUrl: resolveServerHttpBaseUrl(),
          token: credentials.token,
        });
        if (snapshot.status !== 'ready' || !supportsConnectedServiceOperation(snapshot.features, serviceId)) {
          throw Object.assign(new Error(`This server has not confirmed support for connected service '${serviceId}'. Upgrade the server or retry when it is reachable.`), {
            code: 'connected_service_unsupported',
          });
        }
      }
      if (authIntent.kind === 'token') {
        const promptLabel =
          authIntent.tokenKind === 'setup-token'
            ? 'Paste Claude setup-token (from `claude setup-token`): '
            : authIntent.tokenKind === 'access-token'
              ? 'Paste GitHub access token: '
              : serviceId === 'openai'
                ? 'Paste OpenAI API key: '
                : 'Paste Anthropic API key: ';
        const token = (await promptInput(promptLabel)).trim();
        if (!token) {
          throw new Error(
            authIntent.tokenKind === 'setup-token'
              ? 'Missing setup-token'
              : authIntent.tokenKind === 'access-token'
                ? 'Missing access token'
                : 'Missing API key',
          );
        }
        return buildConnectedServiceCredentialRecord({
          now,
          serviceId,
          profileId: options.profileId,
          kind: 'token',
          token: { token, providerAccountId: null, providerEmail: null },
        });
      }

      const oauth = await target.authenticate({
        paste: options.paste,
        device: options.device,
        noOpen: options.noOpen,
        timeoutSeconds: options.timeoutSeconds ?? undefined,
      });
      postConnectPayload = oauth;

      return buildConnectedAccountOauthCredentialRecord({
        now,
        serviceId,
        profileId: options.profileId,
        payload: oauth,
      });
    })();

    console.log(info(`Registering ${target.displayName} credential with relay (${record.serviceId}/${options.profileId})`));
    await storeConnectedServiceCredentialForAccount({
      api,
      credentials,
      record,
    });

    console.log(ok(`${target.displayName} credential registered with relay`));
    if (postConnectPayload !== null) {
      target.postConnect?.(postConnectPayload);
    }
    process.exit(0);
}

/**
 * Show every profile of every vendor's connected services, or only those with `profileFilter`.
 */
async function handleConnectStatus(
    targets: ReadonlyArray<CloudConnectTarget>,
    params: Readonly<{ profileFilter: string | null }>,
): Promise<void> {
    console.log(`\n${sectionTitle('Connection status')}\n`);

    // Check if authenticated
    const credentials = await readCredentials();
    if (!credentials) {
        console.log(warn('Not authenticated with Happier'));
        console.log(chalk.gray('  Please run "happier auth login" first'));
        process.exit(1);
    }

    // Create API client
    const api = await ApiClient.create(credentials);

    const vendors: ConnectStatusVendor[] = [];
    for (const target of targets) {
      let serviceIds: ConnectedServiceId[];
      try {
        serviceIds = resolveConnectTargetServiceIds(target.id);
      } catch (error) {
        if (process.env.DEBUG) {
          console.error(chalk.gray(`[debug] failed to resolve ${target.vendorDisplayName} services:`), error);
        }
        vendors.push({ vendorDisplayName: target.vendorDisplayName, kind: 'unresolved' });
        continue;
      }
      if (serviceIds.length === 0) {
        vendors.push({ vendorDisplayName: target.vendorDisplayName, kind: 'unsupported' });
        continue;
      }
      const services = await Promise.all(serviceIds.map(async (serviceId): Promise<ConnectStatusServiceListing> => {
        try {
          const { profiles } = await api.listConnectedServiceProfiles({ serviceId });
          return { serviceId, outcome: 'listed', profiles };
        } catch (error) {
          if (process.env.DEBUG) {
            console.error(chalk.gray(`[debug] failed to check ${target.vendorDisplayName} (${serviceId}) connection:`), error);
          }
          return { serviceId, outcome: 'failed' };
        }
      }));
      vendors.push({ vendorDisplayName: target.vendorDisplayName, kind: 'services', services });
    }

    for (const line of formatConnectStatusLines({ vendors, profileFilter: params.profileFilter })) {
      console.log(line);
    }

    console.log('');
    console.log(chalk.gray('To connect a vendor, run: happier connect <vendor>'));
    console.log(chalk.gray('Example: happier connect gemini'));
    console.log('');
}

export async function handleConnectCliCommand(context: CommandContext): Promise<void> {
  try {
    await handleConnectCommand(context.args.slice(1));
  } catch (error) {
    console.error(fail(error instanceof Error ? error.message : 'Unknown error'));
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}
