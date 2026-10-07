import { describe, expect, it } from 'vitest';

import {
    readCodexAppServerRequestTimeoutMs,
    readCodexAppServerRpcTimeoutMs,
    readCodexAppServerStartupRpcTimeoutMs,
} from './codexAppServerRpcTimeout';

describe('codexAppServerRpcTimeout', () => {
    it('defaults base RPC timeout to the load-tolerant 60s session-control budget', () => {
        expect(readCodexAppServerRpcTimeoutMs({} as NodeJS.ProcessEnv)).toBe(60_000);
    });

    it('clamps base RPC timeout to the configured value when set', () => {
        expect(readCodexAppServerRpcTimeoutMs({ HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '1200' } as NodeJS.ProcessEnv)).toBe(1200);
        expect(readCodexAppServerRpcTimeoutMs({ HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '0' } as NodeJS.ProcessEnv)).toBe(60_000);
        expect(readCodexAppServerRpcTimeoutMs({ HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '-5' } as NodeJS.ProcessEnv)).toBe(60_000);
        expect(readCodexAppServerRpcTimeoutMs({ HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '9999999' } as NodeJS.ProcessEnv)).toBe(600_000);
    });

    it('keeps provider side-effecting thread, turn, and resume admission lifecycle-owned', () => {
        const env = {
            HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '1200',
            HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS: '20000',
        } as NodeJS.ProcessEnv;

        expect(readCodexAppServerRequestTimeoutMs('initialize', env)).toBe(20_000);
        expect(readCodexAppServerRequestTimeoutMs('thread/start', env)).toBeNull();
        expect(readCodexAppServerRequestTimeoutMs('thread/resume', env)).toBeNull();
        expect(readCodexAppServerRequestTimeoutMs('turn/start', env)).toBeNull();
        expect(readCodexAppServerRequestTimeoutMs('turn/steer', env)).toBeNull();
        expect(readCodexAppServerRequestTimeoutMs('model/list', env)).toBe(1200);
    });

    it('bounds process initialization but not side-effecting thread admission', () => {
        expect(readCodexAppServerStartupRpcTimeoutMs({} as NodeJS.ProcessEnv)).toBe(60_000);
        expect(readCodexAppServerRequestTimeoutMs('initialize', {} as NodeJS.ProcessEnv)).toBe(60_000);
        expect(readCodexAppServerRequestTimeoutMs('thread/start', {} as NodeJS.ProcessEnv)).toBeNull();
    });

    it('keeps provider-native fork requests alive without inflating ordinary RPCs', () => {
        const env = {
            HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '1200',
        } as NodeJS.ProcessEnv;

        expect(readCodexAppServerRequestTimeoutMs('thread/fork', env)).toBeNull();
        expect(readCodexAppServerRequestTimeoutMs('conversation/fork', env)).toBeNull();
        expect(readCodexAppServerRequestTimeoutMs('model/list', env)).toBe(1200);
    });

    it('ensures startup timeout is never lower than the base timeout', () => {
        const env = {
            HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '25000',
            HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS: '20000',
        } as NodeJS.ProcessEnv;

        expect(readCodexAppServerStartupRpcTimeoutMs(env)).toBe(25_000);
        expect(readCodexAppServerRequestTimeoutMs('initialize', env)).toBe(25_000);
    });
});
