import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';
import { ConnectedServiceRefreshCoordinator } from '@/daemon/connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';
import { registerConnectedServiceRuntimeTargetForDaemon } from '@/daemon/connectedServices/startup/runtimeTargetRegistration';

import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';
import { makeMode } from './claudeRemoteAgentSdk.testkit';

const { bridge } = vi.hoisted(() => ({
    bridge: { coordinator: null as null | { refreshClaudeSubscriptionTokensForBridge: (input: any) => Promise<unknown> } },
}));

vi.mock('@/runtime/js/ensureJavaScriptRuntimeExecutable', () => ({
    ensureJavaScriptRuntimeExecutable: vi.fn(async () => '/managed/js-runtime'),
}));

// The control client is the process boundary; past it the daemon's control-server handler hands the
// request body to the coordinator unchanged (startDaemon handleClaudeSubscriptionAuthTokensRefresh).
vi.mock('@/daemon/controlClient', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
    return {
        ...actual,
        refreshDaemonClaudeSubscriptionAnthropicAuthTokensForBridge: async (input: any) => {
            if (!bridge.coordinator) throw new Error('fixture: no daemon');
            return await bridge.coordinator.refreshClaudeSubscriptionTokensForBridge({
                sessionId: input.sessionId,
                brokerSelectionIdentity: null,
                selection: input.selection,
                forceRefresh: input.forceRefresh,
                failingAccessTokenFingerprint: input.failingAccessTokenFingerprint ?? null,
            });
        },
    };
});

const credentials = {
    token: 'happy-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
} satisfies Credentials;

const HAPPIER_SESSION_ID = 'cmw0happier0session0id00001';
const NATIVE_CLAUDE_SESSION_ID = 'c7354b9f-9ad3-4169-82a9-8fa36734edb1';
const PROFILE_ID = 'claude-pro';
const SELECTION = { kind: 'profile', serviceId: 'claude-subscription', profileId: PROFILE_ID } as const;

/**
 * A daemon whose registry holds the session's target exactly as every daemon registration site keys
 * it: by the Happier session id. The selected credential is a setup token, served as-is with no
 * provider call.
 */
function startDaemon(registeredSessionId: string) {
    const record = buildConnectedServiceCredentialRecord({
        now: 1_000,
        serviceId: 'claude-subscription',
        profileId: PROFILE_ID,
        kind: 'token',
        token: { token: 'sk-ant-oat01-setup', providerAccountId: 'anthropic-acct', providerEmail: null },
    });
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');
    const sealed = sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: { type: 'legacy', secret: credentials.encryption.secret },
        payload: record,
        randomBytes: (length) => randomBytes(length),
    });
    const api = {
        readConnectedServiceCredentialHealth: vi.fn(async () => ({ kind: 'found' as const, status: 'connected' as const, health: null })),
        getConnectedServiceCredentialSealed: vi.fn(async () => ({
            sealed: { format: 'account_scoped_v1', ciphertext: sealed },
            metadata: { kind: 'token', providerEmail: null, providerAccountId: 'anthropic-acct', expiresAt: null },
        })),
    } as unknown as ApiClient;
    const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
    const coordinator = new ConnectedServiceRefreshCoordinator({
        api,
        credentials,
        machineIdProvider: () => 'm1',
        ownerIdProvider: () => 'm1:d',
        activeServerDir: '/tmp/x',
        baseDir: '/tmp/y',
        refreshWindowMs: 60_000,
        refreshLeaseMs: 30_000,
        now: () => 1_000,
        runtimeRegistry,
    });
    registerConnectedServiceRuntimeTargetForDaemon({
        runtimeRegistry,
        pid: 4242,
        sessionId: registeredSessionId,
        agentId: 'claude',
        connectedServicesBindingsRaw: {
            v: 1,
            bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'profile', profileId: PROFILE_ID } },
        },
        materializationKey: registeredSessionId,
    });
    bridge.coordinator = coordinator;
}

async function runSdkAndAskForToken(nativeSessionId: string | null): Promise<Readonly<{ token: Promise<string | null> }>> {
    const transcriptPath = nativeSessionId
        ? join(await mkdtemp(join(tmpdir(), 'happier-claude-oauth-identity-')), `${nativeSessionId}.jsonl`)
        : null;
    if (transcriptPath) await writeFile(transcriptPath, '{"type":"summary"}\n', 'utf8');
    let options: any = null;
    const createQuery = vi.fn((params: any) => {
        options = params.options;
        return {
            async *[Symbol.asyncIterator]() { yield { type: 'result' } as any; },
            close: vi.fn(), setPermissionMode: vi.fn(), setModel: vi.fn(), setMaxThinkingTokens: vi.fn(),
            supportedCommands: vi.fn(async () => []), supportedModels: vi.fn(async () => []),
        } as any;
    });
    let sent = false;
    await claudeRemoteAgentSdk({
        // As claudeRemoteLauncher passes them: the native Claude resume id (null when fresh) and the
        // Happier session id.
        sessionId: nativeSessionId,
        happySessionId: HAPPIER_SESSION_ID,
        transcriptPath,
        path: '/tmp',
        claudeArgs: [],
        claudeExecutablePath: '/tmp/claude',
        claudeSubscriptionAccessTokenRefreshSelection: SELECTION,
        canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
        isAborted: () => false,
        nextMessage: async () => {
            if (sent) return null;
            sent = true;
            return { message: 'hello', mode: makeMode({ permissionMode: 'default' }) };
        },
        onReady: () => {},
        onSessionFound: () => {},
        onMessage: () => {},
        createQuery,
    } as any);
    expect(typeof options?.getOAuthToken).toBe('function');
    return { token: options.getOAuthToken({ signal: new AbortController().signal }) };
}

afterEach(() => {
    bridge.coordinator = null;
});

describe('claudeRemoteAgentSdk getOAuthToken session identity', () => {
    it('reaches the daemon target registered under the Happier session id when resuming a native session', async () => {
        startDaemon(HAPPIER_SESSION_ID);
        await expect((await runSdkAndAskForToken(NATIVE_CLAUDE_SESSION_ID)).token).resolves.toBe('sk-ant-oat01-setup');
    });

    it('reaches the daemon target registered under the Happier session id for a fresh native session', async () => {
        startDaemon(HAPPIER_SESSION_ID);
        await expect((await runSdkAndAskForToken(null)).token).resolves.toBe('sk-ant-oat01-setup');
    });

    it('is still refused when no target is registered under its Happier session id', async () => {
        startDaemon('cmw0some0other0happier0sess');
        await expect((await runSdkAndAskForToken(NATIVE_CLAUDE_SESSION_ID)).token).rejects.toThrow();
    });
});
