import type { AccountProfile, DirectSessionsProviderId, DirectSessionsSource } from '@happier-dev/protocol';

import { getAgentBehavior, getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import type { Settings } from '@/sync/domains/settings/settings';

import { resolveDirectBrowseSourceOptions } from './resolveDirectBrowseSourceOptions';

/**
 * Whether the resume-id picker can browse the provider's own sessions. Both a directly readable
 * provider session store and a resume-only ACP `session/list` source qualify, because the picker
 * only ever returns a vendor resume id for a new Happier-owned session.
 */
export function canBrowseDirectSessions(agentId: AgentId): boolean {
    const browse = getAgentBehavior(agentId).directSessions?.browse;
    if (typeof browse?.getSourceOptions !== 'function') return false;
    return getAgentCore(agentId).sessionStorage.direct === true || browse.resumeOnly === true;
}

export function resolveDirectBrowseLockedSource(params: Readonly<{
    providerId: DirectSessionsProviderId;
    agentOptionState?: Record<string, unknown> | null;
    profile: Pick<AccountProfile, 'connectedServicesV2'> | null | undefined;
    settings: Pick<Settings, 'connectedServicesProfileLabelByKey'>;
    directory?: string | null;
}>): DirectSessionsSource | null {
    const sourceOptions = resolveDirectBrowseSourceOptions({
        providerId: params.providerId,
        profile: params.profile,
        settings: params.settings,
        directory: params.directory ?? null,
    });
    if (sourceOptions.length === 0) return null;

    const resolver = getAgentBehavior(params.providerId as unknown as AgentId).directSessions?.browse?.resolveLockedSourceOption;
    const resolvedOption = resolver
        ? resolver({
            agentId: params.providerId as unknown as AgentId,
            sourceOptions,
            agentOptionState: params.agentOptionState ?? null,
            profile: params.profile,
            settings: params.settings as Settings,
        })
        : null;

    return (resolvedOption ?? sourceOptions[0])?.source ?? null;
}
