import { describe, expect, it } from 'vitest';

import {
  applyOpenCodeManagedServerAuthHeaders,
  mintOpenCodeManagedServerPassword,
  resolveOpenCodeManagedServerCredentialChildEnv,
  resolveOpenCodeManagedServerLaunchCredential,
  resolveOpenCodeManagedServerReadinessCredentials,
  resolveOpenCodeManagedServerStateCredential,
} from './openCodeManagedServerCredential';

const BASE_URL = 'http://127.0.0.1:41234';

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

describe('resolveOpenCodeManagedServerLaunchCredential', () => {
  it('mints a distinct high-entropy password per launch and marks it for retention', () => {
    const first = resolveOpenCodeManagedServerLaunchCredential({});
    const second = resolveOpenCodeManagedServerLaunchCredential({});

    expect(first.credential.username).toBe('opencode');
    expect(first.credential.password.length).toBeGreaterThanOrEqual(32);
    expect(first.retainedPassword).toBe(first.credential.password);
    expect(second.credential.password).not.toBe(first.credential.password);
    expect(mintOpenCodeManagedServerPassword()).not.toBe(first.credential.password);
  });

  it('prefers the canonical OpenCode 2 password and its fixed username over legacy overrides', () => {
    expect(resolveOpenCodeManagedServerLaunchCredential({
      OPENCODE_PASSWORD: 'modern-secret',
      OPENCODE_SERVER_PASSWORD: 'legacy-secret',
      OPENCODE_SERVER_USERNAME: 'legacy-proxy-user',
    }).credential).toEqual({ username: 'opencode', password: 'modern-secret' });
  });

  it('adopts an operator-configured credential without writing its password down', () => {
    // An operator credential is re-derived from the environment, username override included, so it
    // never has to be copied into the managed-server state file.
    expect(resolveOpenCodeManagedServerLaunchCredential({
      OPENCODE_SERVER_PASSWORD: 'legacy-secret',
      OPENCODE_SERVER_USERNAME: 'proxy-user',
    })).toEqual({
      credential: { username: 'proxy-user', password: 'legacy-secret' },
      retainedPassword: null,
    });
  });

  it('never applies a username override to a minted credential (the server pins `opencode`)', () => {
    expect(resolveOpenCodeManagedServerLaunchCredential({ OPENCODE_SERVER_USERNAME: 'proxy-user' })
      .credential.username).toBe('opencode');
  });
});

describe('resolveOpenCodeManagedServerReadinessCredentials', () => {
  it('keeps distinct operator passwords aligned with the V1 and V2 server contracts', () => {
    const env = {
      OPENCODE_PASSWORD: 'canonical-secret',
      OPENCODE_SERVER_PASSWORD: 'legacy-secret',
      OPENCODE_SERVER_USERNAME: 'legacy-proxy-user',
    };
    const launch = resolveOpenCodeManagedServerLaunchCredential(env);

    expect(resolveOpenCodeManagedServerReadinessCredentials({ env, launchCredential: launch.credential }))
      .toEqual({
        v1: { username: 'legacy-proxy-user', password: 'legacy-secret' },
        v2: { username: 'opencode', password: 'canonical-secret' },
      });
  });
});

describe('resolveOpenCodeManagedServerStateCredential', () => {
  it('authenticates a running server with the password retained for that exact baseUrl', () => {
    expect(resolveOpenCodeManagedServerStateCredential({
      state: { baseUrl: `${BASE_URL}/`, authPassword: 'retained-secret' },
      baseUrl: BASE_URL,
      env: {},
    })).toEqual({ username: 'opencode', password: 'retained-secret' });
  });

  it('refuses a retained password recorded for a different server', () => {
    expect(resolveOpenCodeManagedServerStateCredential({
      state: { baseUrl: 'http://127.0.0.1:59999', authPassword: 'retained-secret' },
      baseUrl: BASE_URL,
      env: {},
    })).toBeNull();
  });

  it('preserves legacy password and custom username for predecessor V1 state without a generation', () => {
    expect(resolveOpenCodeManagedServerStateCredential({
      state: { baseUrl: BASE_URL },
      baseUrl: BASE_URL,
      env: {
        OPENCODE_SERVER_PASSWORD: 'legacy-secret',
        OPENCODE_SERVER_USERNAME: 'legacy-proxy-user',
      },
    })).toEqual({ username: 'legacy-proxy-user', password: 'legacy-secret' });
  });

  it('uses the fixed OpenCode 2 username for a detected V2 server with only the legacy password configured', () => {
    expect(resolveOpenCodeManagedServerStateCredential({
      state: { baseUrl: BASE_URL, apiGeneration: 'v2' },
      baseUrl: BASE_URL,
      env: {
        OPENCODE_SERVER_PASSWORD: 'legacy-secret',
        OPENCODE_SERVER_USERNAME: 'legacy-proxy-user',
      },
    })).toEqual({ username: 'opencode', password: 'legacy-secret' });
  });

  it('preserves the custom username for a retained V1 server with only the legacy password configured', () => {
    expect(resolveOpenCodeManagedServerStateCredential({
      state: { baseUrl: BASE_URL, apiGeneration: 'auto' },
      baseUrl: BASE_URL,
      env: {
        OPENCODE_SERVER_PASSWORD: 'legacy-secret',
        OPENCODE_SERVER_USERNAME: 'legacy-proxy-user',
      },
    })).toEqual({ username: 'legacy-proxy-user', password: 'legacy-secret' });
  });

  it('uses the legacy password and custom username for detected V1 when both variables differ', () => {
    expect(resolveOpenCodeManagedServerStateCredential({
      state: { baseUrl: BASE_URL, apiGeneration: 'auto' },
      baseUrl: BASE_URL,
      env: {
        OPENCODE_PASSWORD: 'canonical-secret',
        OPENCODE_SERVER_PASSWORD: 'legacy-secret',
        OPENCODE_SERVER_USERNAME: 'legacy-proxy-user',
      },
    })).toEqual({ username: 'legacy-proxy-user', password: 'legacy-secret' });
  });

  it('uses the canonical password and fixed username for detected V2 when both variables differ', () => {
    expect(resolveOpenCodeManagedServerStateCredential({
      state: { baseUrl: BASE_URL, apiGeneration: 'v2' },
      baseUrl: BASE_URL,
      env: {
        OPENCODE_PASSWORD: 'canonical-secret',
        OPENCODE_SERVER_PASSWORD: 'legacy-secret',
        OPENCODE_SERVER_USERNAME: 'legacy-proxy-user',
      },
    })).toEqual({ username: 'opencode', password: 'canonical-secret' });
  });

  it('re-derives a canonical OpenCode 2 password with the managed server fixed username', () => {
    expect(resolveOpenCodeManagedServerStateCredential({
      state: { baseUrl: BASE_URL, apiGeneration: 'v2' },
      baseUrl: BASE_URL,
      env: {
        OPENCODE_PASSWORD: 'modern-secret',
        OPENCODE_SERVER_USERNAME: 'legacy-proxy-user',
      },
    })).toEqual({ username: 'opencode', password: 'modern-secret' });
  });

  it('has no credential when neither the state nor the environment carries one', () => {
    expect(resolveOpenCodeManagedServerStateCredential({ state: null, baseUrl: BASE_URL, env: {} })).toBeNull();
  });
});

describe('applyOpenCodeManagedServerAuthHeaders', () => {
  it('replaces the live Authorization header when the managed server is replaced', () => {
    const headers: Record<string, string> = { Authorization: basic('opencode', 'previous-secret') };

    applyOpenCodeManagedServerAuthHeaders(headers, {
      state: { baseUrl: BASE_URL, authPassword: 'next-secret' },
      baseUrl: BASE_URL,
      env: {},
    });

    expect(headers.Authorization).toBe(basic('opencode', 'next-secret'));
  });

  it('drops the Authorization header when no credential applies', () => {
    const headers: Record<string, string> = { Authorization: basic('opencode', 'previous-secret') };

    applyOpenCodeManagedServerAuthHeaders(headers, { state: null, env: {} });

    expect(headers.Authorization).toBeUndefined();
  });
});

describe('resolveOpenCodeManagedServerCredentialChildEnv', () => {
  it('projects only the canonical OpenCode 2 password variable', () => {
    // The retained OpenCode 1 line does not know OPENCODE_PASSWORD, so a stable-generation managed
    // server keeps serving exactly as before instead of demanding an unverified legacy contract.
    expect(resolveOpenCodeManagedServerCredentialChildEnv({ username: 'opencode', password: 'secret' }))
      .toEqual({ OPENCODE_PASSWORD: 'secret' });
  });
});
