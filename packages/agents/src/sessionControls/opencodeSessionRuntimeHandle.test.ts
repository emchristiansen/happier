import { describe, expect, it } from 'vitest';

import {
  readOpenCodeSessionAffinityFromMetadata,
  readOpenCodeSessionRuntimeHandleFromMetadata,
} from './opencodeSessionRuntimeHandle.js';

describe('opencodeSessionRuntimeHandle', () => {
  it.each(['', { invalid: true }])('retains malformed recorded affinity without substituting a legacy hint: %s', (value) => {
    expect(readOpenCodeSessionRuntimeHandleFromMetadata({
      opencodeManagedServerLaunchFingerprint: 'b'.repeat(64),
      agentRuntimeDescriptorV1: { v: 1, providerId: 'opencode', provider: {
        backendMode: 'server', vendorSessionId: 'native-target',
        providerExtra: { v: 1, runtimeHandle: { managedServerLaunchFingerprint: value } },
      } },
    })).toMatchObject({ vendorSessionId: 'native-target', managedServerLaunchFingerprint: '' });
  });
  it('prefers providerExtra runtime handle fields over provider and legacy metadata', () => {
    expect(readOpenCodeSessionRuntimeHandleFromMetadata({
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'opencode',
        provider: {
          backendMode: 'acp',
          vendorSessionId: 'legacy_oc',
          serverBaseUrl: 'http://127.0.0.1:4999/',
          serverBaseUrlExplicit: false,
          providerExtra: {
            v: 1,
            runtimeHandle: {
              backendMode: 'server',
              vendorSessionId: 'oc_1',
              serverBaseUrl: 'http://127.0.0.1:4096/',
              serverBaseUrlExplicit: true,
            },
          },
        },
      },
      opencodeSessionId: 'legacy-session',
      opencodeBackendMode: 'acp',
      opencodeServerBaseUrl: 'http://127.0.0.1:4888/',
      opencodeServerBaseUrlExplicit: false,
    })).toEqual({
      backendMode: 'server',
      vendorSessionId: 'oc_1',
      serverBaseUrl: 'http://127.0.0.1:4096/',
      serverBaseUrlExplicit: true,
      managedServerLaunchFingerprint: null,
    });
  });

  it('prefers agentRuntimeDescriptorV1 over legacy OpenCode metadata', () => {
    expect(readOpenCodeSessionRuntimeHandleFromMetadata({
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'opencode',
        provider: {
          backendMode: 'server',
          vendorSessionId: 'oc_1',
          serverBaseUrl: 'http://127.0.0.1:4096/',
          serverBaseUrlExplicit: true,
        },
      },
      opencodeSessionId: 'legacy-session',
      opencodeBackendMode: 'acp',
      opencodeServerBaseUrl: 'http://127.0.0.1:4999/',
      opencodeServerBaseUrlExplicit: false,
    })).toEqual({
      backendMode: 'server',
      vendorSessionId: 'oc_1',
      serverBaseUrl: 'http://127.0.0.1:4096/',
      serverBaseUrlExplicit: true,
      managedServerLaunchFingerprint: null,
    });
  });

  it('falls back to legacy explicit server metadata when no runtime descriptor exists', () => {
    expect(readOpenCodeSessionAffinityFromMetadata({
      opencodeBackendMode: 'acp',
      opencodeServerBaseUrl: ' http://127.0.0.1:4999/ ',
      opencodeServerBaseUrlExplicit: 'true',
    })).toEqual({
      backendMode: 'acp',
      serverBaseUrl: 'http://127.0.0.1:4999/',
      serverBaseUrlExplicit: true,
      managedServerLaunchFingerprint: null,
    });
  });
});
