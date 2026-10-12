import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installSessionGuidanceCommonModuleMocks } from './sessionGuidanceTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async (_text: string) => {}),
}));

vi.mock('expo-constants', () => ({
    default: { expoConfig: null, manifest: null },
}));

vi.mock('expo-updates', () => ({
    channel: null,
    releaseChannel: null,
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props, null),
}));

vi.mock('expo-image', () => ({
    Image: (props: any) => React.createElement('Image', props, null),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: any) => React.createElement('RoundButton', props, null),
}));

const tauriState = vi.hoisted(() => ({
    desktop: false,
}));

const connectTerminalHookState = vi.hoisted(() => ({
    calls: 0,
}));

const routerMockState = vi.hoisted(() => ({
    push: vi.fn(),
    useRouterCalls: 0,
}));
const machineState = vi.hoisted(() => ({
    machines: [] as Array<{ active: boolean }>,
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => tauriState.desktop,
}));

vi.mock('@/config', () => ({
    config: { variant: 'production', cliNpmDistTag: undefined },
}));

vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => {
        connectTerminalHookState.calls += 1;
        return {
            connectTerminal: () => {},
            connectWithUrl: () => {},
            isLoading: false,
        };
    },
}));

vi.mock('@/hooks/session/useVisibleSessionListViewData', () => ({
    useVisibleSessionListSessionSummary: () => ({ sessionsReady: true, visibleSessionCount: 0 }),
}));

vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useResolvedActiveServerSelection: () => ({
        activeTarget: { kind: 'server', id: 's1' },
        activeServerId: 's1',
        allowedServerIds: ['s1'],
    }),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerSnapshot: () => ({ serverId: 's1', generation: 1 }),
    listServerProfiles: () => [{ id: 's1', name: 'dev', serverUrl: 'http://127.0.0.1:3005' }],
}));

/** U7 — what the one "this computer" projection says, and its one action. */
const driftState = vi.hoisted(() => ({
    banner: null as null | Record<string, unknown>,
}));
vi.mock('@/components/settings/server/useRelayDriftBanner', () => ({
    useRelayDriftBanner: () => driftState.banner,
}));
vi.mock('@/components/settings/server/RelayDriftActionCard', () => ({
    RelayDriftActionCard: (props: { banner: Record<string, unknown> }) => React.createElement('RelayDriftActionCard', { ...props.banner, testID: 'relay-drift-banner' }),
}));

/** R11 — whether the Home's setup panel is on screen now (its own owner proves that contract). */
const setupPanelState = vi.hoisted(() => ({ showing: false }));
vi.mock('@/setup/DesktopLocalSetupRuntime', () => ({
    useDesktopLocalSetupPanelShowing: () => setupPanelState.showing,
}));

vi.mock('@/sync/domains/features/featureBuildPolicy', () => ({
    getFeatureBuildPolicyDecision: () => 'neutral',
}));

installSessionGuidanceCommonModuleMocks({
    router: () => ({
        router: { push: routerMockState.push },
        useRouter: () => {
            routerMockState.useRouterCalls += 1;
            return { push: routerMockState.push };
        },
    }),
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useMachineListByServerId: () => ({ s1: machineState.machines }),
            useMachineListStatusByServerId: () => ({ s1: 'idle' }),
            useSetting: (key: string) => {
                if (key === 'serverSelectionGroups') return [];
                if (key === 'newSessionDraftEntryMode') return 'resumePrevious';
                return undefined;
            },
            useActiveServerAccountScope: () => null,
        });
    },
});

describe('SessionGettingStartedGuidance (desktop-only setup CTA)', () => {
    beforeEach(() => {
        connectTerminalHookState.calls = 0;
        routerMockState.push.mockClear();
        routerMockState.useRouterCalls = 0;
        machineState.machines = [];
        driftState.banner = null;
        setupPanelState.showing = false;
    });

    it('leaves "this computer" to the setup panel while it is on screen, and takes it back once it goes (R11)', async () => {
        tauriState.desktop = true;
        setupPanelState.showing = true;
        vi.resetModules();
        const { SessionGettingStartedGuidance } = await import('./SessionGettingStartedGuidance');

        for (const variant of ['primaryPane', 'sidebar', 'phone'] as const) {
            const screen = await renderScreen(<SessionGettingStartedGuidance variant={variant} />);
            // One owner, one prompt: no second "Set up this computer" beside the panel's run.
            expect(() => screen.tree.root.findByProps({ testID: 'session-getting-started-open-setup' })).toThrow();
            expect(() => screen.tree.root.findByProps({ testID: 'session-getting-started-setup-primary-card' })).toThrow();
            screen.tree.unmount();
        }

        // `/new`'s blocking guidance is its own modal, not beside the panel: it keeps its entry.
        const blocking = await renderScreen(<SessionGettingStartedGuidance variant="newSessionBlocking" />);
        expect(() => blocking.tree.root.findByProps({ testID: 'session-getting-started-open-setup' })).not.toThrow();
        blocking.tree.unmount();

        // A reconciliation run is the same concept: its drift card is not repeated either.
        driftState.banner = { title: 't', description: 'd', actionLabel: 'a', onPress: vi.fn() };
        const drift = await renderScreen(<SessionGettingStartedGuidance variant="primaryPane" />);
        expect(() => drift.tree.root.findByProps({ testID: 'relay-drift-banner' })).toThrow();
        drift.tree.unmount();

        // Ready or declined: the panel is gone and the card's own behaviour returns.
        driftState.banner = null;
        setupPanelState.showing = false;
        const after = await renderScreen(<SessionGettingStartedGuidance variant="primaryPane" />);
        expect(() => after.tree.root.findByProps({ testID: 'session-getting-started-open-setup' })).not.toThrow();
    });

    it('says what this computer is connected to, with the one connect action, when its daemon is elsewhere (U7)', async () => {
        tauriState.desktop = true;
        const onPress = vi.fn();
        driftState.banner = {
            title: 'server.relayDrift.bannerDifferentRelayTitle',
            description: 'This computer is connected to self.example.test as bob.',
            actionLabel: 'server.relayDrift.connectHereAction',
            onPress,
        };
        vi.resetModules();
        const { SessionGettingStartedGuidance } = await import('./SessionGettingStartedGuidance');

        const tree: renderer.ReactTestRenderer = (await renderScreen(<SessionGettingStartedGuidance variant="primaryPane" />)).tree;
        const card = tree.root.findByProps({ testID: 'relay-drift-banner' });
        expect(card.props.description).toContain('self.example.test');
        expect(() => tree.root.findByProps({ testID: 'session-getting-started-open-setup' })).toThrow();
    });

    it('does not re-teach installing the command line the desktop app already installed (U13)', async () => {
        tauriState.desktop = true;
        vi.resetModules();
        const { SessionGettingStartedGuidance } = await import('./SessionGettingStartedGuidance');

        const tree: renderer.ReactTestRenderer = (await renderScreen(<SessionGettingStartedGuidance variant="sidebar" />)).tree;
        await renderer.act(async () => {
            tree.root.findByProps({ testID: 'session-getting-started-show-manual' }).props.onPress();
        });
        expect(() => tree.root.findByProps({ testID: 'session-getting-started-step-install_cli' })).toThrow();
        expect(() => tree.root.findByProps({ testID: 'session-getting-started-step-auth_login' })).not.toThrow();
    });

    it('hides the Open setup CTA on non-Tauri surfaces', async () => {
        tauriState.desktop = false;
        vi.resetModules();
        const { SessionGettingStartedGuidance } = await import('./SessionGettingStartedGuidance');

        const tree: renderer.ReactTestRenderer = (await renderScreen(<SessionGettingStartedGuidance variant="sidebar" />)).tree;
        expect(() => tree.root.findByProps({ testID: 'session-getting-started-open-setup' })).toThrow();
        expect(connectTerminalHookState.calls).toBe(0);
        expect(routerMockState.useRouterCalls).toBe(0);
    });

    it('points web and phone at the computer to connect, never a desktop flow they do not have (U13)', async () => {
        tauriState.desktop = false;
        vi.resetModules();
        const { SessionGettingStartedGuidance } = await import('./SessionGettingStartedGuidance');

        const tree: renderer.ReactTestRenderer = (await renderScreen(<SessionGettingStartedGuidance variant="sidebar" />)).tree;
        const texts = tree.root.findAll((node) => typeof node.props.children === 'string').map((node) => String(node.props.children));
        expect(texts.some((text) => text.includes('sessionGettingStarted.subtitle.connectMachineElsewhere'))).toBe(true);
        expect(texts.some((text) => text.startsWith('sessionGettingStarted.subtitle.connectMachine') && !text.includes('Elsewhere'))).toBe(false);
    });

    it('shows the Open setup CTA on Tauri desktop', async () => {
        tauriState.desktop = true;
        vi.resetModules();
        const { SessionGettingStartedGuidance } = await import('./SessionGettingStartedGuidance');

        const tree: renderer.ReactTestRenderer = (await renderScreen(<SessionGettingStartedGuidance variant="sidebar" />)).tree;
        expect(() => tree.root.findByProps({ testID: 'session-getting-started-open-setup' })).not.toThrow();
    });

    it('routes the Open setup CTA to the canonical manual this-computer surface, not the first-run /setup route', async () => {
        tauriState.desktop = true;
        vi.resetModules();
        const { SessionGettingStartedGuidance } = await import('./SessionGettingStartedGuidance');

        const tree: renderer.ReactTestRenderer = (await renderScreen(<SessionGettingStartedGuidance variant="sidebar" />)).tree;
        tree.root.findByProps({ testID: 'session-getting-started-open-setup' }).props.onPress();

        expect(routerMockState.push).toHaveBeenCalledWith('/settings/machines/this-computer');
        expect(routerMockState.push).not.toHaveBeenCalledWith('/setup');
    });

    it('routes the create-session CTA through the ordinary-entry resolver with pointer modifiers', async () => {
        machineState.machines = [{ active: true }];
        vi.resetModules();
        const { SessionGettingStartedGuidance } = await import('./SessionGettingStartedGuidance');

        const tree = (await renderScreen(<SessionGettingStartedGuidance variant="sidebar" />)).tree;
        tree.root.findByProps({ testID: 'session-getting-started-start-new-session' }).props.onPress({
            nativeEvent: { ctrlKey: true },
        });

        expect(routerMockState.push).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                draftId: expect.any(String),
                draftOrigin: 'ordinary',
            },
        });
    });
});
