import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { ConnectedServiceIdSchema } from '@happier-dev/protocol';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installConnectedServicesCommonModuleMocks, connectedServicesModuleState } from './connectedServicesTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installConnectedServicesCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
            },
        });
    },
    searchParams: { serviceId: 'openai-codex', profileId: 'work' },
});

const useFeatureEnabledSpy = vi.fn((_featureId: string) => false);
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) => useFeatureEnabledSpy(featureId),
}));

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: { token: 't', secret: 's' } }),
}));

vi.mock('@/components/ui/navigation/OAuthView', () => ({
  OAuthView: () => React.createElement('OAuthView'),
  OAuthViewUnsupported: (props: unknown) => React.createElement('OAuthViewUnsupported', props as Record<string, unknown>),
}));

vi.mock('@/sync/domains/connectedServices/connectedServiceRegistry', () => ({
  getConnectedServiceRegistryEntry: (_serviceId: string) => ({ serviceId: 'openai-codex', connectCommand: 'happier connect codex', supportsOauth: true }),
}));

describe('ConnectedServiceOauthView gating', () => {
  beforeEach(async () => {
    const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
    resetServerFeaturesClientForTests();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  it('refuses a new-service deep link while server operation support is unknown', async () => {
    connectedServicesModuleState.searchParams = { serviceId: 'antigravity', profileId: 'work', method: 'paste' };
    useFeatureEnabledSpy.mockReturnValue(true);
    const { ConnectedServiceOauthView } = await import('./ConnectedServiceOauthView');
    const screen = await renderScreen(<ConnectedServiceOauthView />);
    expect(screen.getTextContent()).toContain('connectedServices.detail.errors.serviceUnsupportedServer');
    expect(screen.findByTestId('connectedServices.oauthPaste.openAuthorizationButton')).toBeNull();
  });
  it('activates new-service OAuth after the relay advertises support', async () => {
    connectedServicesModuleState.searchParams = { serviceId: 'antigravity', profileId: 'work', method: 'paste' };
    useFeatureEnabledSpy.mockReturnValue(true);
    const features = createRootLayoutFeaturesResponse({ capabilities: { connectedServices: {
      credentialDelete: { revisionGuard: false }, credentialWrite: { revisionGuard: false }, supportedServiceIds: [...ConnectedServiceIdSchema.options],
    } } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(features), { status: 200, headers: { 'content-type': 'application/json' } })));
    const { ConnectedServiceOauthView } = await import('./ConnectedServiceOauthView');
    const screen = await renderScreen(<ConnectedServiceOauthView />);
    await act(async () => {
      const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
      await getServerFeaturesSnapshot();
    });
    expect(screen.findByTestId('connectedServices.oauthPaste.openAuthorizationButton')).not.toBeNull();
    expect(screen.getTextContent()).not.toContain('connectedServices.detail.errors.serviceUnsupportedServer');
  });
  it('does not expose native OAuth flow when connected services are disabled', async () => {
    useFeatureEnabledSpy.mockImplementation((featureId: string) => featureId !== 'connectedServices');
    const { ConnectedServiceOauthView } = await import('./ConnectedServiceOauthView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ConnectedServiceOauthView />)).tree;

    expect(tree.findAllByType('OAuthViewUnsupported' as any).length).toBeGreaterThan(0);
    expect(tree.findAllByType('OAuthView' as any)).toHaveLength(0);
  });
});
