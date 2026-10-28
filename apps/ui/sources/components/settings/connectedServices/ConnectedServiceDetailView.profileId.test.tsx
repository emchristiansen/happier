import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import {
    connectedServicesModuleState,
    installConnectedServiceDetailShellMocks,
    installConnectedServicesCommonModuleMocks,
} from './connectedServicesTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/auth/context/AuthContext', () => {
  // AuthProvider retains credentials identity until authentication changes.
  const credentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') };
  return { useAuth: () => ({ credentials }) };
});

const promptSpy = vi.fn(async () => 'work/bad');
const alertSpy = vi.fn(async () => {});
const applySettingsSpy = vi.fn(async () => {});
installConnectedServicesCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                prompt: promptSpy,
                alert: alertSpy,
                confirm: vi.fn(async () => false),
            },
        }).module;
    },
    searchParams: { serviceId: 'openai-codex' },
});
installConnectedServiceDetailShellMocks();

vi.mock('@/sync/store/settingsWriters', () => ({
  useApplySettings: () => applySettingsSpy,
}));

let connectedServicesEnabled = true;
let quotasEnabled = false;
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) => {
    if (featureId === 'connectedServices') return connectedServicesEnabled;
    if (featureId === 'connectedServices.accountGroups') return false;
    if (featureId === 'connectedServices.quotas') return quotasEnabled;
    return true;
  },
}));

vi.mock('@/sync/store/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/sync/store/hooks')>('@/sync/store/hooks');
  return {
    ...actual,
    useProfile: () => ({
      connectedServicesV2: [
        {
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth', providerEmail: null }],
        },
      ],
    }),
    useSettings: () => ({
      connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'work' },
      connectedServicesProfileLabelByKey: {},
      connectedServicesQuotaPinnedMeterIdsByKey: {},
      connectedServicesQuotaSummaryStrategyByKey: {},
    }),
  };
});

vi.mock('@/sync/sync', () => ({
  sync: { refreshProfile: vi.fn(async () => {}), applySettings: vi.fn(async () => {}) },
}));

vi.mock('@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount', () => ({
  storeConnectedServiceCredentialForAccount: vi.fn(async () => {}),
  deleteConnectedServiceCredentialForAccount: vi.fn(async () => {}),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => {
  const React = require('react');
  return {
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props, props.children),
  };
});

describe('ConnectedServiceDetailView profile id validation', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    connectedServicesModuleState.routerBackSpy.mockClear();
    connectedServicesModuleState.routerPushSpy.mockClear();
    promptSpy.mockClear();
    alertSpy.mockClear();
    applySettingsSpy.mockClear();
    connectedServicesEnabled = true;
    quotasEnabled = false;
    connectedServicesModuleState.searchParams = { serviceId: 'openai-codex' };
  });

  it('does not expose OAuth authoring for a new-service deep link until relay support is known', async () => {
    connectedServicesModuleState.searchParams = { serviceId: 'antigravity' };
    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
    const screen = await renderScreen(<ConnectedServiceDetailView />);
    expect(screen.tree.findAll((node) => String(node.props.testID ?? '').startsWith('connected-services-action:add-oauth-profile'))).toHaveLength(0);
    expect(promptSpy).not.toHaveBeenCalled();
    expect(connectedServicesModuleState.routerPushSpy).not.toHaveBeenCalled();
  });

  it('rejects invalid profile ids before navigating to oauth connect', async () => {
    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;

    const add = tree.find((n) => n.props?.testID === 'connected-services-action:add-oauth-profile-device');
    await act(async () => {
      await pressTestInstanceAsync(add);
    });

    expect(alertSpy).toHaveBeenCalled();
    expect(connectedServicesModuleState.routerPushSpy).not.toHaveBeenCalled();
  });

  it('shows a fallback alert when routing to oauth connect fails', async () => {
    promptSpy.mockResolvedValueOnce('work');
    connectedServicesModuleState.routerPushSpy.mockImplementationOnce(() => {
      throw new Error('route failed');
    });

    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;

    const add = tree.find((n) => n.props?.testID === 'connected-services-action:add-oauth-profile-device');
    await act(async () => {
      await pressTestInstanceAsync(add);
    });

    expect(connectedServicesModuleState.routerPushSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/settings/connected-services/oauth',
        params: expect.objectContaining({
          serviceId: 'openai-codex',
          profileId: 'work',
          method: 'device',
        }),
      }),
    );
    expect(alertSpy).toHaveBeenCalled();
  });

  it('does not violate hooks order when feature state changes between renders', async () => {
    connectedServicesEnabled = false;

    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
    const Inner = (ConnectedServiceDetailView as unknown as { type: React.ComponentType<Record<string, never>> }).type;

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<Inner />)).tree;

    connectedServicesEnabled = true;
    await act(async () => {
      tree.update(<Inner />);
    });

    expect(tree.root).toBeDefined();
  });
});
