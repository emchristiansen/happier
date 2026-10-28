import type { Session } from '@/sync/domains/state/storageTypes';
import type { CliAuthStatusData } from '@/sync/api/capabilities/capabilitiesProtocol';
import { getSessionLocalControlState, isSessionExclusiveLocalControl } from '@/sync/domains/session/control/sessionLocalControl';
import { AGENTS_CORE, resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { ConnectedServiceBindingsV1Schema } from '@happier-dev/protocol';

type SessionControlAuthState = CliAuthStatusData['state'] | null | undefined;

export function shouldRequestRemoteControl(session: Session | null, authState?: SessionControlAuthState): boolean {
    if (!session || !isSessionExclusiveLocalControl(session)) return false;
    if (authState === 'logged_out') {
        const agentId = resolveAgentIdFromSessionMetadata(session.metadata);
        const core = agentId ? AGENTS_CORE[agentId] : null;
        const serviceIds = core && 'connectedServices' in core ? core.connectedServices?.supportedServiceIds ?? [] : [];
        const bindings = ConnectedServiceBindingsV1Schema.safeParse(session.metadata?.connectedServices);
        // Machine auth probes inspect ambient credentials, not this selected authentication.
        // Its validity remains unknown here; the switch RPC and provider validate it.
        const usesConnectedAuthentication = bindings.success && serviceIds.some((serviceId) =>
            bindings.data.bindingsByServiceId[serviceId]?.source === 'connected');
        if (!usesConnectedAuthentication) return false;
    }
    return true;
}

export function shouldRequestRemoteControlAfterPendingEnqueue(session: Session | null, authState?: SessionControlAuthState): boolean {
    return shouldRequestRemoteControl(session, authState);
}

/** Explicit user action: shared release detaches the owned terminal, not the model. */
export function shouldOfferLocalControlRelease(session: Session | null, authState?: SessionControlAuthState): boolean {
    const localControl = getSessionLocalControlState(session);
    if (localControl?.topology === 'shared') return localControl.attached && localControl.canDetach;
    return shouldRequestRemoteControl(session, authState);
}

export function shouldRenderChatTimelineForSession(opts: {
    committedMessagesCount: number;
    pendingMessagesCount: number;
    controlledByUser: boolean;
    forceRenderFooter?: boolean;
}): boolean {
    return opts.committedMessagesCount > 0
        || opts.pendingMessagesCount > 0
        || opts.controlledByUser === true
        || opts.forceRenderFooter === true;
}
