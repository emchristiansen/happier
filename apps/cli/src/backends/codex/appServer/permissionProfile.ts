import type { PermissionMode } from '@/api/types';
import { normalizePermissionModeToIntent } from '@/agent/runtime/permission/permissionModeCanonical';

import { resolveCodexAppServerPolicyForPermissionMode } from '../utils/permissionModePolicy';

export type CodexAppServerPermissionProfileId = ':read-only' | ':workspace' | ':danger-no-sandbox';

export type CodexAppServerPermissionsParams = Readonly<{
    permissions?: Readonly<{
        type: 'profile';
        id: CodexAppServerPermissionProfileId;
    }>;
}>;

export type CodexAppServerLegacyPermissionTarget = 'thread' | 'turn';

export function resolveCodexAppServerPermissionProfileId(
    permissionMode: PermissionMode,
): CodexAppServerPermissionProfileId | null {
    switch (normalizePermissionModeToIntent(permissionMode)) {
        case 'read-only':
            return ':read-only';
        case 'safe-yolo':
        case 'plan':
            return ':workspace';
        case 'yolo':
            return ':danger-no-sandbox';
        case 'default':
        default:
            return null;
    }
}

export function buildCodexAppServerPermissionsParams(params: Readonly<{
    permissionMode: PermissionMode;
}>): CodexAppServerPermissionsParams {
    const id = resolveCodexAppServerPermissionProfileId(params.permissionMode);
    return id ? { permissions: { type: 'profile', id } } : {};
}

export function buildCodexAppServerLegacyPermissionParams(params: Readonly<{
    permissionMode: PermissionMode;
    directory: string;
    target: CodexAppServerLegacyPermissionTarget;
    managedScalarFallback?: boolean;
}>): Record<string, unknown> {
    if (params.permissionMode === 'default') return {};

    const policy = resolveCodexAppServerPolicyForPermissionMode(params.permissionMode, {
        directory: params.directory,
        managedScalarFallback: params.managedScalarFallback,
    });

    return {
        approvalPolicy: policy.approvalPolicy,
        ...(policy.approvalsReviewer ? { approvalsReviewer: policy.approvalsReviewer } : {}),
        ...(params.target === 'thread'
            ? { sandbox: policy.sandbox }
            : { sandboxPolicy: policy.sandboxPolicy }),
    };
}

export function readCodexAppServerActivePermissionProfile(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const active = record.activePermissionProfile ?? record.active_permission_profile;
    if (!active || typeof active !== 'object' || Array.isArray(active)) return null;
    return active as Record<string, unknown>;
}
