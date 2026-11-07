import { INSTALLABLE_KEYS } from '@happier-dev/protocol/installables';

import type { AgentUiBehavior, NewSessionRelevantInstallableDepsContext } from '@/agents/registry/registryUiBehavior';

export function getAgyNewSessionRelevantInstallableDepKeys(ctx: NewSessionRelevantInstallableDepsContext): readonly string[] {
    if (ctx.agentId !== 'agy') return [];
    return [INSTALLABLE_KEYS.AGY_ACP_SERVER];
}

export const AGY_UI_BEHAVIOR_OVERRIDE: AgentUiBehavior = {
    newSession: {
        getRelevantInstallableDepKeys: getAgyNewSessionRelevantInstallableDepKeys,
    },
};
