import type { AgentId } from '@/agents/catalog/catalog';
import type { DaemonTerminalLaunchIntent } from '@happier-dev/protocol';

export type ProviderLocalAuthSupport = 'login_terminal' | 'status_only' | 'manual_only' | 'unsupported';

type ProviderLocalAuthLaunchBase = Readonly<{
    kind: 'primary' | 'device_code';
    initialInput?: string | null;
}>;

export type ProviderLocalAuthLaunch =
    | (ProviderLocalAuthLaunchBase & Readonly<{ initialCommand: string; launch?: never }>)
    | (ProviderLocalAuthLaunchBase & Readonly<{ launch: DaemonTerminalLaunchIntent; initialCommand?: never }>);

export type ProviderLocalAuthPlugin = Readonly<{
    providerId: AgentId;
    support: ProviderLocalAuthSupport;
    docsUrl?: string | null;
    buildAuthLaunches?: (params: Readonly<{
        resolvedPath?: string | null;
        resolvedCommand?: string | null;
        platform?: NodeJS.Platform | string | null;
    }>) => ReadonlyArray<ProviderLocalAuthLaunch>;
    statusHelpText?: string;
}>;
