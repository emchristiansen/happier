import type { AgentId } from '@/agents/catalog/catalog';
import { getAgentLocalCliConfig, getProviderCliInstallGuideUrl, getProviderCliRuntimeSpec } from '@happier-dev/agents';

import { createStaticProviderLocalAuthPlugin } from './createStaticProviderLocalAuthPlugin';
import type { ProviderLocalAuthPlugin } from './providerLocalAuthPlugin';
import { resolveProviderLocalAuthBaseCommand } from './resolveProviderLocalAuthBaseCommand';

function buildInitialCommand(params: Readonly<{
    providerId: AgentId;
    launch: Extract<ReturnType<typeof getAgentLocalCliConfig>['authLaunches'][number], { target: 'provider_cli' }>;
    resolvedPath?: string | null;
    resolvedCommand?: string | null;
    platform?: NodeJS.Platform | string | null;
}>): string {
    const config = getAgentLocalCliConfig(params.providerId);
    const baseCommand = resolveProviderLocalAuthBaseCommand({
        resolvedPath: params.resolvedPath,
        resolvedCommand: params.resolvedCommand,
        fallbackCommand: params.launch.command ?? getProviderCliRuntimeSpec(params.providerId).binaryName ?? config.detectKey,
        platform: params.platform,
    });
    const args = params.launch.args;
    return args.length > 0 ? [baseCommand, ...args].join(' ') : baseCommand;
}

export function createCatalogProviderLocalAuthPlugin(providerId: AgentId): ProviderLocalAuthPlugin {
    const config = getAgentLocalCliConfig(providerId);
    return createStaticProviderLocalAuthPlugin({
        providerId,
        support: config.authSupport,
        docsUrl: getProviderCliInstallGuideUrl(providerId) ?? undefined,
        ...(config.authLaunches.length > 0
            ? {
                buildAuthLaunches: ({ resolvedPath, resolvedCommand, platform }) => config.authLaunches.map((launch) => {
                    const shared = {
                        kind: launch.kind,
                        ...(launch.initialInput ? { initialInput: launch.initialInput } : {}),
                    };
                    if (launch.target === 'happier_cli') {
                        return {
                            ...shared,
                            launch: { kind: 'happier_cli' as const, args: [...launch.args] },
                        };
                    }
                    return {
                        ...shared,
                        initialCommand: buildInitialCommand({ providerId, launch, resolvedPath, resolvedCommand, platform }),
                    };
                }),
            }
            : {}),
    });
}
