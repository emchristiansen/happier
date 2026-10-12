import { describe, expect, it } from 'vitest';

import {
    buildCodexAppServerLegacyPermissionParams,
    buildCodexAppServerPermissionsParams,
} from './permissionProfile';

describe('permissionProfile', () => {
    it('maps Happier read-only mode to the Codex built-in read-only permission profile', () => {
        expect(buildCodexAppServerPermissionsParams({ permissionMode: 'read-only' })).toEqual({
            permissions: { type: 'profile', id: ':read-only' },
        });
    });

    it('maps workspace write modes to the Codex workspace profile', () => {
        expect(buildCodexAppServerPermissionsParams({ permissionMode: 'acceptEdits' })).toEqual({
            permissions: { type: 'profile', id: ':workspace' },
        });
        expect(buildCodexAppServerPermissionsParams({ permissionMode: 'safe-yolo' })).toEqual({
            permissions: { type: 'profile', id: ':workspace' },
        });
    });

    it('maps bypass modes to the Codex danger-no-sandbox profile', () => {
        expect(buildCodexAppServerPermissionsParams({ permissionMode: 'yolo' })).toEqual({
            permissions: { type: 'profile', id: ':danger-no-sandbox' },
        });
        expect(buildCodexAppServerPermissionsParams({ permissionMode: 'bypassPermissions' })).toEqual({
            permissions: { type: 'profile', id: ':danger-no-sandbox' },
        });
    });

    it('omits native permission profile params for default mode', () => {
        expect(buildCodexAppServerPermissionsParams({ permissionMode: 'default' })).toEqual({});
    });

    it('keeps legacy thread and turn params separate from native permissions params', () => {
        expect(buildCodexAppServerLegacyPermissionParams({
            permissionMode: 'read-only',
            directory: '/repo',
            target: 'turn',
        })).toEqual({
            approvalPolicy: 'never',
            sandboxPolicy: {
                type: 'readOnly',
                access: { type: 'fullAccess' },
                networkAccess: true,
            },
        });

        expect(buildCodexAppServerLegacyPermissionParams({
            permissionMode: 'acceptEdits',
            directory: '/repo',
            target: 'thread',
        })).toEqual({
            approvalPolicy: {
                granular: expect.objectContaining({
                    mcp_elicitations: true,
                    request_permissions: true,
                    sandbox_approval: true,
                }),
            },
            approvalsReviewer: 'auto_review',
            sandbox: 'workspace-write',
        });

        expect(buildCodexAppServerLegacyPermissionParams({
            permissionMode: 'acceptEdits',
            directory: '/repo',
            target: 'thread',
            managedScalarFallback: true,
        })).toMatchObject({
            approvalPolicy: 'on-request',
            approvalsReviewer: 'user',
            sandbox: 'workspace-write',
        });
    });
});
