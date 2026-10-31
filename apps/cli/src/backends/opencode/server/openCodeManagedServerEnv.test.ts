import { describe, expect, it } from 'vitest';

import {
  resolveOpenCodeManagedServerChildEnv,
  resolveOpenCodeManagedServerLaunchFingerprint,
} from './openCodeManagedServerEnv';

describe('resolveOpenCodeManagedServerChildEnv', () => {
  it('defaults OPENCODE_CONFIG_CONTENT when missing and does not override XDG dirs when no xdgRootDir is provided', () => {
    const env = resolveOpenCodeManagedServerChildEnv({
      baseEnv: { PATH: '/bin', XDG_CONFIG_HOME: '/cfg' },
      xdgRootDir: null,
      isolateConfig: false,
    });

    expect(env.PATH).toBe('/bin');
    expect(env.OPENCODE_CONFIG_CONTENT).toBe('{}');
    expect(env.XDG_CONFIG_HOME).toBe('/cfg');
    expect(env.XDG_DATA_HOME).toBeUndefined();
    expect(env.XDG_STATE_HOME).toBeUndefined();
    expect(env.XDG_CACHE_HOME).toBeUndefined();
  });

  it('does not synthesize OpenCode config paths from the Happier stack home', () => {
    const env = resolveOpenCodeManagedServerChildEnv({
      baseEnv: {
        PATH: '/bin',
        HOME: '/Users/example',
        HAPPIER_HOME_DIR: '/tmp/happier-home',
      },
      xdgRootDir: null,
      isolateConfig: false,
    });

    expect(env.HOME).toBe('/Users/example');
    expect(env.HAPPIER_HOME_DIR).toBe('/tmp/happier-home');
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
    expect(env.XDG_DATA_HOME).toBeUndefined();
    expect(env.XDG_STATE_HOME).toBeUndefined();
    expect(env.XDG_CACHE_HOME).toBeUndefined();
  });

  it('preserves user home and config env when a Happier stack home is configured', () => {
    const env = resolveOpenCodeManagedServerChildEnv({
      baseEnv: {
        PATH: '/bin',
        HOME: '/Users/example',
        USERPROFILE: '/Users/example-profile',
        HAPPIER_HOME_DIR: '/tmp/happier-home',
        XDG_CONFIG_HOME: '/Users/example/.config',
        XDG_DATA_HOME: '/Users/example/.local/share',
        XDG_STATE_HOME: '/Users/example/.local/state',
        XDG_CACHE_HOME: '/Users/example/.cache',
      },
      xdgRootDir: null,
      isolateConfig: false,
    });

    expect(env.HOME).toBe('/Users/example');
    expect(env.USERPROFILE).toBe('/Users/example-profile');
    expect(env.HAPPIER_HOME_DIR).toBe('/tmp/happier-home');
    expect(env.XDG_CONFIG_HOME).toBe('/Users/example/.config');
    expect(env.XDG_DATA_HOME).toBe('/Users/example/.local/share');
    expect(env.XDG_STATE_HOME).toBe('/Users/example/.local/state');
    expect(env.XDG_CACHE_HOME).toBe('/Users/example/.cache');
  });

  it('preserves inherited XDG_CONFIG_HOME instead of replacing it with the Happier stack home', () => {
    const env = resolveOpenCodeManagedServerChildEnv({
      baseEnv: {
        PATH: '/bin',
        HOME: '/Users/example',
        HAPPIER_HOME_DIR: '/tmp/happier-home',
        XDG_CONFIG_HOME: '/Users/example/.config',
      },
      xdgRootDir: null,
      isolateConfig: false,
    });

    expect(env.HOME).toBe('/Users/example');
    expect(env.XDG_CONFIG_HOME).toBe('/Users/example/.config');
  });

  it('sets XDG data/state/cache directories under xdgRootDir and preserves existing config dir by default', () => {
    const env = resolveOpenCodeManagedServerChildEnv({
      baseEnv: { XDG_CONFIG_HOME: '/cfg', OPENCODE_CONFIG_CONTENT: '{"ok":true}' },
      xdgRootDir: '/xdg-root',
      isolateConfig: false,
    });

    expect(env.OPENCODE_CONFIG_CONTENT).toBe('{"ok":true}');
    expect(env.XDG_DATA_HOME).toBe('/xdg-root/data');
    expect(env.XDG_STATE_HOME).toBe('/xdg-root/state');
    expect(env.XDG_CACHE_HOME).toBe('/xdg-root/cache');
    expect(env.XDG_CONFIG_HOME).toBe('/cfg');
  });

  it('can isolate config directory under xdgRootDir when requested', () => {
    const env = resolveOpenCodeManagedServerChildEnv({
      baseEnv: { XDG_CONFIG_HOME: '/cfg' },
      xdgRootDir: '/xdg-root',
      isolateConfig: true,
    });

    expect(env.XDG_CONFIG_HOME).toBe('/xdg-root/config');
  });

  it('injects the managed server credential as the canonical OpenCode 2 password variable only', () => {
    const env = resolveOpenCodeManagedServerChildEnv({
      baseEnv: { PATH: '/bin' },
      xdgRootDir: null,
      isolateConfig: false,
      authCredential: { username: 'opencode', password: 'managed-secret' },
    });

    expect(env.OPENCODE_PASSWORD).toBe('managed-secret');
    // The retained OpenCode 1 line does not know OPENCODE_PASSWORD, so a stable-generation managed
    // server keeps serving unauthenticated instead of demanding a legacy credential contract.
    expect(env.OPENCODE_SERVER_PASSWORD).toBeUndefined();
  });

  it('leaves the child password env untouched when no managed credential is supplied', () => {
    const env = resolveOpenCodeManagedServerChildEnv({
      baseEnv: { PATH: '/bin', OPENCODE_SERVER_PASSWORD: 'operator-legacy' },
      xdgRootDir: null,
      isolateConfig: false,
    });

    expect(env.OPENCODE_PASSWORD).toBeUndefined();
    expect(env.OPENCODE_SERVER_PASSWORD).toBe('operator-legacy');
  });

  it('changes the launch fingerprint when the operator-configured OpenCode 2 password changes', () => {
    const fingerprintA = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: { HOME: '/Users/example', OPENCODE_PASSWORD: 'secret-a' },
      xdgRootDir: null,
      isolateConfig: false,
    });
    const fingerprintB = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: { HOME: '/Users/example', OPENCODE_PASSWORD: 'secret-b' },
      xdgRootDir: null,
      isolateConfig: false,
    });

    expect(fingerprintA).not.toBe(fingerprintB);
  });

  it('changes the launch fingerprint when auth-relevant provider env changes', () => {
    const fingerprintA = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: {
        HOME: '/Users/example',
        OPENAI_API_KEY: 'key-a',
        OPENCODE_SERVER_USERNAME: 'user-a',
      },
      xdgRootDir: '/xdg-root',
      isolateConfig: true,
    });

    const fingerprintB = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: {
        HOME: '/Users/example',
        OPENAI_API_KEY: 'key-b',
        OPENCODE_SERVER_USERNAME: 'user-a',
      },
      xdgRootDir: '/xdg-root',
      isolateConfig: true,
    });

    expect(fingerprintA).not.toBe(fingerprintB);
  });

  it('uses the requested CLI generation as part of managed-server reuse identity', () => {
    const stable = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: {
        HOME: '/Users/example',
        HAPPIER_OPENCODE_CLI_GENERATION: 'stable',
      },
      xdgRootDir: null,
      isolateConfig: false,
    });
    const v2 = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: {
        HOME: '/Users/example',
        HAPPIER_OPENCODE_CLI_GENERATION: 'v2',
      },
      xdgRootDir: null,
      isolateConfig: false,
    });

    expect(stable).not.toBe(v2);
  });

  it('changes the launch fingerprint when USERPROFILE changes without HOME', () => {
    const fingerprintA = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: {
        USERPROFILE: 'C:\\Users\\alice',
      },
      xdgRootDir: null,
      isolateConfig: false,
    });

    const fingerprintB = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: {
        USERPROFILE: 'C:\\Users\\bob',
      },
      xdgRootDir: null,
      isolateConfig: false,
    });

    expect(fingerprintA).not.toBe(fingerprintB);
  });

  it('falls back to the auth-content hash (no raw auth content) when no stable selection identity is provided', () => {
    // Native / pre-broker transition path: with no connected-service selection identity, the
    // fingerprint conservatively keys on the auth bytes so two different stored credentials never
    // collide. (Once a selection identity is supplied, see the rotation-stable tests below.)
    const authContentA = JSON.stringify({ openai: { type: 'api', key: 'sk-account-a' } });
    const authContentB = JSON.stringify({ openai: { type: 'api', key: 'sk-account-b' } });

    const fingerprintA = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: {
        HOME: '/Users/example',
        OPENCODE_AUTH_CONTENT: authContentA,
      },
      xdgRootDir: '/xdg-root',
      isolateConfig: true,
    });

    const fingerprintB = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: {
        HOME: '/Users/example',
        OPENCODE_AUTH_CONTENT: authContentB,
      },
      xdgRootDir: '/xdg-root',
      isolateConfig: true,
    });

    expect(fingerprintA).not.toBe(fingerprintB);
    expect(fingerprintA).not.toContain('sk-account-a');
    expect(fingerprintA).not.toContain(authContentA);
  });

  it('keeps the fingerprint UNCHANGED when the token rotates for the same connected-service selection identity', () => {
    // Core fix (plan §2.3): same account + rotated token => unchanged fingerprint => no server churn.
    const fingerprintBefore = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: {
        HOME: '/Users/example',
        OPENCODE_AUTH_CONTENT: JSON.stringify({ openai: { type: 'oauth', access: 'access-1', refresh: 'refresh-1', expires: 111 } }),
      },
      xdgRootDir: '/xdg-root',
      isolateConfig: true,
      connectedServiceSelectionIdentity: 'opencode|connected|openai-codex|profile-a',
    });

    const fingerprintAfterRotation = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: {
        HOME: '/Users/example',
        // Same account, rotated token bytes.
        OPENCODE_AUTH_CONTENT: JSON.stringify({ openai: { type: 'oauth', access: 'access-2', refresh: 'refresh-2', expires: 222 } }),
      },
      xdgRootDir: '/xdg-root',
      isolateConfig: true,
      connectedServiceSelectionIdentity: 'opencode|connected|openai-codex|profile-a',
    });

    expect(fingerprintAfterRotation).toBe(fingerprintBefore);
    expect(fingerprintBefore).not.toContain('access-1');
    expect(fingerprintBefore).not.toContain('refresh-1');
  });

  it('reads the selection identity from HAPPIER_OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY env when no explicit param is given', () => {
    const viaEnv = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: {
        HOME: '/Users/example',
        OPENCODE_AUTH_CONTENT: JSON.stringify({ openai: { type: 'oauth', access: 'rotating-1' } }),
        HAPPIER_OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY: 'opencode|connected|openai-codex|profile-a',
      },
      xdgRootDir: '/xdg-root',
      isolateConfig: true,
    });

    const viaParam = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: {
        HOME: '/Users/example',
        OPENCODE_AUTH_CONTENT: JSON.stringify({ openai: { type: 'oauth', access: 'rotating-2' } }),
      },
      xdgRootDir: '/xdg-root',
      isolateConfig: true,
      connectedServiceSelectionIdentity: 'opencode|connected|openai-codex|profile-a',
    });

    expect(viaEnv).toBe(viaParam);
  });

  it('produces DIFFERENT fingerprints for two different connected-service accounts (never collapse to one identity)', () => {
    const accountA = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: { HOME: '/Users/example', OPENCODE_AUTH_CONTENT: '{"openai":{"type":"oauth","access":"x"}}' },
      xdgRootDir: '/xdg-root',
      isolateConfig: true,
      connectedServiceSelectionIdentity: 'opencode|connected|openai-codex|profile-a',
    });
    const accountB = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: { HOME: '/Users/example', OPENCODE_AUTH_CONTENT: '{"openai":{"type":"oauth","access":"x"}}' },
      xdgRootDir: '/xdg-root',
      isolateConfig: true,
      connectedServiceSelectionIdentity: 'opencode|connected|openai-codex|profile-b',
    });
    expect(accountA).not.toBe(accountB);
  });

  it('changes the fingerprint when the broker plugin / config content changes for the same account', () => {
    const common = {
      HOME: '/Users/example',
      OPENCODE_AUTH_CONTENT: '{"openai":{"type":"api","key":"broker-marker"}}',
    } as const;
    const withoutBroker = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: { ...common, OPENCODE_CONFIG_CONTENT: '{}' },
      xdgRootDir: '/xdg-root',
      isolateConfig: true,
      connectedServiceSelectionIdentity: 'opencode|connected|openai-codex|profile-a',
    });
    const withBroker = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: { ...common, OPENCODE_CONFIG_CONTENT: '{"plugin":["/path/to/broker.js"]}' },
      xdgRootDir: '/xdg-root',
      isolateConfig: true,
      connectedServiceSelectionIdentity: 'opencode|connected|openai-codex|profile-a',
    });
    expect(withoutBroker).not.toBe(withBroker);
  });

  it('changes the fingerprint when the opencode binary identity changes (explicit param or HAPPIER_OPENCODE_PATH)', () => {
    const v1 = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: { HOME: '/Users/example' },
      xdgRootDir: null,
      isolateConfig: false,
      openCodeBinaryIdentity: 'opencode@1.14.41|/usr/local/bin/opencode',
    });
    const v2 = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: { HOME: '/Users/example' },
      xdgRootDir: null,
      isolateConfig: false,
      openCodeBinaryIdentity: 'opencode@1.15.0|/usr/local/bin/opencode',
    });
    expect(v1).not.toBe(v2);

    const pathA = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: { HOME: '/Users/example', HAPPIER_OPENCODE_PATH: '/opt/a/opencode' },
      xdgRootDir: null,
      isolateConfig: false,
    });
    const pathB = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: { HOME: '/Users/example', HAPPIER_OPENCODE_PATH: '/opt/b/opencode' },
      xdgRootDir: null,
      isolateConfig: false,
    });
    expect(pathA).not.toBe(pathB);
  });

  it('changes the fingerprint when config isolation mode changes', () => {
    const common = {
      baseEnv: { HOME: '/Users/example', XDG_CONFIG_HOME: '/Users/example/.config' },
      xdgRootDir: '/xdg-root',
      connectedServiceSelectionIdentity: 'opencode|connected|openai-codex|profile-a',
    } as const;
    const notIsolated = resolveOpenCodeManagedServerLaunchFingerprint({ ...common, isolateConfig: false });
    const isolated = resolveOpenCodeManagedServerLaunchFingerprint({ ...common, isolateConfig: true });
    expect(notIsolated).not.toBe(isolated);
  });

  it('keeps a stable empty-auth-class fingerprint for native sessions and never collides with connected', () => {
    const nativeEnv = {
      HOME: '/Users/example',
      XDG_CONFIG_HOME: '/Users/example/.config',
    };
    const native = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: nativeEnv,
      xdgRootDir: null,
      isolateConfig: false,
    });
    // Stable across repeated resolution (native has no rotating auth bytes).
    expect(resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: nativeEnv,
      xdgRootDir: null,
      isolateConfig: false,
    })).toBe(native);

    const connected = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: {
        ...nativeEnv,
        OPENCODE_AUTH_CONTENT: '{"openai":{"type":"oauth","access":"x"}}',
      },
      xdgRootDir: null,
      isolateConfig: false,
      connectedServiceSelectionIdentity: 'opencode|connected|openai-codex|profile-a',
    });
    expect(native).not.toBe(connected);
  });

  it('CHANGES the fingerprint when a DIRECT API key rotates under the same selection identity (F3)', () => {
    // F3: a direct API key (real secret in OPENCODE_AUTH_CONTENT) is NOT brokered, so a key change for
    // the same account must re-key the server — otherwise the stale server keeps using the old key.
    const common = {
      baseEnv: { HOME: '/Users/example' },
      xdgRootDir: '/xdg-root',
      isolateConfig: true,
      // Same selection identity (same account/profile) across both — only the key bytes change.
      connectedServiceSelectionIdentity: 'opencode|connected|anthropic:console-key:',
    } as const;
    const before = resolveOpenCodeManagedServerLaunchFingerprint({
      ...common,
      baseEnv: { ...common.baseEnv, OPENCODE_AUTH_CONTENT: '{"anthropic":{"type":"api","key":"sk-ant-api-OLD"}}' },
    });
    const after = resolveOpenCodeManagedServerLaunchFingerprint({
      ...common,
      baseEnv: { ...common.baseEnv, OPENCODE_AUTH_CONTENT: '{"anthropic":{"type":"api","key":"sk-ant-api-NEW"}}' },
    });
    expect(after).not.toBe(before);
    // The direct key bytes themselves must not leak into the fingerprint string (hashed).
    expect(before).not.toContain('sk-ant-api-OLD');
  });

  it('keeps the fingerprint UNCHANGED when a BROKERED OAuth token rotates (broker marker is stable; no churn) (F3)', () => {
    // The broker marker is a constant string; brokered OAuth rotation never changes OPENCODE_AUTH_CONTENT
    // bytes, so re-folding the non-broker auth hash must NOT reintroduce churn for brokered providers.
    const common = {
      baseEnv: { HOME: '/Users/example' },
      xdgRootDir: '/xdg-root',
      isolateConfig: true,
      connectedServiceSelectionIdentity: 'opencode|connected|broker:1|openai-codex:profile-a:',
    } as const;
    // Both runs carry the SAME stable broker marker (the rotation happens out-of-band via the broker).
    const markerAuth = '{"openai":{"type":"api","key":"happier-broker:openai:1"}}';
    const before = resolveOpenCodeManagedServerLaunchFingerprint({ ...common, baseEnv: { ...common.baseEnv, OPENCODE_AUTH_CONTENT: markerAuth } });
    const after = resolveOpenCodeManagedServerLaunchFingerprint({ ...common, baseEnv: { ...common.baseEnv, OPENCODE_AUTH_CONTENT: markerAuth } });
    expect(after).toBe(before);
  });

  it('does NOT churn when a brokered provider rotates alongside a STABLE direct key (mixed) (F3)', () => {
    // Mixed env: a brokered openai marker (stable) + a direct anthropic key (stable). Neither changes
    // ⇒ unchanged fingerprint. The direct-key fold only reacts to direct-key BYTES, never broker markers.
    const common = {
      baseEnv: { HOME: '/Users/example' },
      xdgRootDir: '/xdg-root',
      isolateConfig: true,
      connectedServiceSelectionIdentity: 'opencode|connected|broker:1|openai-codex:p:|anthropic:k:',
    } as const;
    const auth = '{"openai":{"type":"api","key":"happier-broker:openai:1"},"anthropic":{"type":"api","key":"sk-ant-api-STABLE"}}';
    const a = resolveOpenCodeManagedServerLaunchFingerprint({ ...common, baseEnv: { ...common.baseEnv, OPENCODE_AUTH_CONTENT: auth } });
    const b = resolveOpenCodeManagedServerLaunchFingerprint({ ...common, baseEnv: { ...common.baseEnv, OPENCODE_AUTH_CONTENT: auth } });
    expect(a).toBe(b);
    // Changing ONLY the direct key (broker marker unchanged) re-keys the server.
    const c = resolveOpenCodeManagedServerLaunchFingerprint({
      ...common,
      baseEnv: { ...common.baseEnv, OPENCODE_AUTH_CONTENT: '{"openai":{"type":"api","key":"happier-broker:openai:1"},"anthropic":{"type":"api","key":"sk-ant-api-CHANGED"}}' },
    });
    expect(c).not.toBe(a);
  });

  it('keeps native sessions stable (no direct-key fold applies; empty auth class) (F3)', () => {
    const fp1 = resolveOpenCodeManagedServerLaunchFingerprint({ baseEnv: { HOME: '/Users/example' }, xdgRootDir: null, isolateConfig: false });
    const fp2 = resolveOpenCodeManagedServerLaunchFingerprint({ baseEnv: { HOME: '/Users/example' }, xdgRootDir: null, isolateConfig: false });
    expect(fp1).toBe(fp2);
  });
});
