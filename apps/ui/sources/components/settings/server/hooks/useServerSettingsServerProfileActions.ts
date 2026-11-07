import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import {
    removeServerProfile,
    renameServerProfile,
    resolveServerProfileScopeId,
    type ServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { promptSignedOutServerSwitchConfirmation } from '@/components/settings/server/modals/ServerSwitchAuthPrompt';
import { retargetPendingTerminalConnectToServerUrl } from '@/components/settings/server/hooks/retargetPendingTerminalConnectToServerUrl';
import {
    resolveThisComputerService,
    thisComputerAppManagesService,
    type ThisComputerRelayService,
} from '@/setup/deriveDesktopLocalSetupSnapshot';
import { BackgroundServiceTaskError, disconnectThisComputerFromRelay } from '@/setup/desktopBackgroundServiceControl';
import { desktopSetupCoordinator } from '@/setup/desktopSetupCoordinator';
import { countActiveLocalAgentSessions } from '@/setup/resolveDesktopCloseDaemonDecision';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getStorage } from '@/sync/domains/state/storageStore';
import { isTauriDesktop } from '@/utils/platform/tauri';

import type { ServerAuthStatus } from './useServerAuthStatusByServerId';

/**
 * H3 — the relay's own service on this computer ("connect to this relay too"), if it has one: what
 * removing the relay does to this computer. Read from the one inspection; the default-following
 * service follows the selection and is not the relay's own.
 */
function findThisComputerRelayService(profile: ServerProfile): ThisComputerRelayService | null {
    if (!isTauriDesktop()) {
        return null;
    }
    const inspection = desktopSetupCoordinator.readInspectionSnapshot();
    if (inspection.status !== 'resolved') {
        return null;
    }
    // The one exact-first answer (A12-01): the relay's own row before any alias another daemon
    // answers on; the default-following one is not the relay's own.
    const service = resolveThisComputerService(inspection, { relayUrl: profile.serverUrl, localRelayUrl: null, accountId: null });
    return service?.serviceTargetMode === 'pinned' ? service : null;
}

/**
 * Whether the app can tell for sure that this computer has no service of its own for the relay:
 * the inspection settled and read every pinned service. Otherwise the confirmation says it may.
 */
function thisComputerServicesKnown(): boolean {
    const inspection = desktopSetupCoordinator.readInspectionSnapshot();
    return inspection.status === 'resolved' && inspection.pinnedServicesComplete === true;
}

/**
 * The confirmation's consequence for this computer: it disconnects from the relay (and any agent
 * sessions running here for it end — counted by the canonical owner when the app can see them), a
 * service the user set up stays as it is, or — when the app could not see every service here — it
 * may disconnect.
 */
function describeThisComputerOnRemoval(profile: ServerProfile, service: ThisComputerRelayService | null): string | null {
    if (!isTauriDesktop()) {
        return null;
    }
    if (!service) {
        return thisComputerServicesKnown() ? null : t('server.removeServerMayDisconnectThisComputer', { name: profile.name });
    }
    if (!thisComputerAppManagesService(service)) {
        return t('server.removeServerKeepsUserService', { name: profile.name });
    }
    const visible = getActiveServerSnapshot().serverUrl === profile.serverUrl;
    const running = visible
        ? countActiveLocalAgentSessions({
            sessions: Object.values(getStorage().getState().sessions ?? {}),
            machineId: service.facts.auth.machineId,
        })
        : 0;
    return running > 0
        ? `${t('server.removeServerDisconnectsThisComputer', { name: profile.name })} ${t('server.removeServerEndsSessions', { count: running })}`
        : t('server.removeServerDisconnectsThisComputer', { name: profile.name });
}

export function useServerSettingsServerProfileActions(params: Readonly<{
    authStatusByServerId: Readonly<Record<string, ServerAuthStatus>>;
    /** The screen's direct relay selection (R8/INV7): arms the setup gate's intent, then switches. */
    onSelectServerById: (serverId: string) => Promise<void>;
    onAfterSignedOutSwitch: () => void;

    setRevision: React.Dispatch<React.SetStateAction<number>>;
}>) {
    const onSwitchServer = React.useCallback(async (profile: ServerProfile) => {
        const scopeId = resolveServerProfileScopeId(profile);
        let authStatus = params.authStatusByServerId[scopeId] ?? params.authStatusByServerId[profile.id] ?? 'unknown';
        if (authStatus === 'unknown') {
            try {
                const creds = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, { serverId: profile.id });
                authStatus = creds ? 'signedIn' : 'signedOut';
            } catch {
                authStatus = 'unknown';
            }
        }
        if (authStatus === 'signedOut') {
            const shouldContinue = await promptSignedOutServerSwitchConfirmation();
            if (!shouldContinue) return;
        }

        retargetPendingTerminalConnectToServerUrl(profile.serverUrl);

        await params.onSelectServerById(scopeId);
        if (authStatus === 'signedOut') {
            params.onAfterSignedOutSwitch();
        }
        params.setRevision((r) => r + 1);
    }, [params]);

    const onRenameServer = React.useCallback(async (profile: ServerProfile) => {
        const next = await Modal.prompt(
            t('server.renameServer'),
            t('server.renameServerPrompt'),
            { defaultValue: profile.name, placeholder: t('server.serverNamePlaceholder') }
        );
        if (!next) return;
        try {
            renameServerProfile(profile.id, next);
            params.setRevision((r) => r + 1);
        } catch (err) {
            Modal.alert(t('common.error'), String((err as any)?.message ?? err));
        }
    }, [params]);

    const onRemoveServer = React.useCallback(async (profile: ServerProfile) => {
        const thisComputerService = findThisComputerRelayService(profile);
        const thisComputerConsequence = describeThisComputerOnRemoval(profile, thisComputerService);
        const confirmed = await Modal.confirm(
            t('server.removeServer'),
            thisComputerConsequence
                ? `${t('server.removeServerConfirm', { name: profile.name })}\n\n${thisComputerConsequence}`
                : t('server.removeServerConfirm', { name: profile.name }),
            { confirmText: t('common.remove'), destructive: true }
        );
        if (!confirmed) return;

        // H3/N2 — on desktop this computer disconnects from the relay first, always: the task decides
        // from this computer's own inventory (a no-op when nothing serves the relay, a user-owned
        // service left alone), never from what the app happened to see. Nothing else is removed
        // unless it succeeded: credentials and the profile are what a retry needs.
        if (isTauriDesktop()) {
            try {
                await disconnectThisComputerFromRelay(profile.serverUrl);
            } catch (err) {
                // R10-1 — this computer's services could not be listed at all. When the app knows
                // no service of its own serves the relay, the person may still remove it — after one
                // honest question, never a dead end. A known one of the app's stays: removing the
                // relay would leave that service answering for it.
                const unknown = err instanceof BackgroundServiceTaskError && err.code === 'pinned_services_unknown';
                const knownManaged = thisComputerService !== null && thisComputerAppManagesService(thisComputerService);
                if (!unknown || knownManaged) {
                    Modal.alert(t('common.error'), `${t('server.removeServerDisconnectFailed')}\n${String((err as Error)?.message ?? err)}`);
                    return;
                }
                const removeAnyway = await Modal.confirm(
                    t('server.removeServerAnywayTitle'),
                    t('server.removeServerAnywayBody', { name: profile.name }),
                    { confirmText: t('server.removeServerAnywayConfirm'), destructive: true },
                );
                if (!removeAnyway) return;
            }
            void desktopSetupCoordinator.inspect({ fresh: true }).catch(() => {});
        }

        // Removing a server should clear its local credentials; otherwise re-adding the same URL can
        // resurrect an old token unexpectedly (confusing and potentially unsafe).
        // Do this before removing the profile so TokenStorage can still resolve the serverId scope.
        try {
            await TokenStorage.removeCredentialsForServerUrl(profile.serverUrl, { serverId: profile.id });
        } catch {
            // Best-effort only.
        }
        try {
            removeServerProfile(profile.id);
        } catch (err) {
            Modal.alert(t('common.error'), String((err as any)?.message ?? err));
            return;
        }

        params.setRevision((r) => r + 1);
    }, [params]);

    return {
        onSwitchServer,
        onRenameServer,
        onRemoveServer,
    } as const;
}
