import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

const setBackgroundServiceModeMock = vi.fn(async () => {});
const backgroundServiceState = {
    supported: true,
    mode: 'at-login' as 'at-login' | 'on-demand' | null,
    installed: true as boolean | null,
    loading: false,
    error: null as string | null,
    setMode: setBackgroundServiceModeMock,
};

function createPassthroughComponentMock(tag: string) {
    return (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(tag, props, props.children);
}

installSettingsViewCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
});

vi.mock('./useDesktopBackgroundServiceAutostart', () => ({
    useDesktopBackgroundServiceAutostart: () => backgroundServiceState,
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: createPassthroughComponentMock('ItemGroup'),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: createPassthroughComponentMock('Item'),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: createPassthroughComponentMock('Switch'),
}));

describe('DesktopSettingsSection', () => {
    beforeEach(() => {
        backgroundServiceState.supported = true;
        backgroundServiceState.mode = 'at-login';
        backgroundServiceState.installed = true;
        backgroundServiceState.loading = false;
        backgroundServiceState.error = null;
        setBackgroundServiceModeMock.mockReset();
    });

    it('renders nothing outside the desktop shell', async () => {
        backgroundServiceState.supported = false;
        const { DesktopSettingsSection } = await import('./DesktopSettingsSection');
        const screen = await renderSettingsView(<DesktopSettingsSection />);

        expect(screen.findGroup('settingsDesktop.title')).toBeNull();
    });

    it('offers one login-start setting: no separate launch-at-login row for the app (R16 b)', async () => {
        const { DesktopSettingsSection } = await import('./DesktopSettingsSection');
        const screen = await renderSettingsView(<DesktopSettingsSection />);

        // The app starts at login exactly when the background service does, in menu-bar mode, so a
        // second switch for the app would be a second answer to the same question.
        expect(screen.findRow('settings-desktop-autostart-enabled')).toBeNull();
        expect(screen.findRow('settings-desktop-background-service-enabled')).toBeTruthy();
    });

    it('renders the background-service row and reflects the installed mode', async () => {
        const { DesktopSettingsSection } = await import('./DesktopSettingsSection');
        const screen = await renderSettingsView(<DesktopSettingsSection />);

        const row = screen.findRow('settings-desktop-background-service-enabled');

        expect(row?.props.rightElement.props.value).toBe(true);
        expect(row?.props.rightElement.props.disabled).toBe(false);
    });

    it('changes the installed service mode through its own hook', async () => {
        const { DesktopSettingsSection } = await import('./DesktopSettingsSection');
        const screen = await renderSettingsView(<DesktopSettingsSection />);

        // The switch is a boolean control over a two-mode fact: the row states the mode the CLI
        // parses, so nothing downstream has to translate a boolean back into one.
        screen.findRow('settings-desktop-background-service-enabled')?.props.rightElement.props.onValueChange(false);

        expect(setBackgroundServiceModeMock).toHaveBeenCalledWith('on-demand');
    });

    it('restores the login trigger with the at-login mode', async () => {
        backgroundServiceState.mode = 'on-demand';
        const { DesktopSettingsSection } = await import('./DesktopSettingsSection');
        const screen = await renderSettingsView(<DesktopSettingsSection />);
        const row = screen.findRow('settings-desktop-background-service-enabled');

        expect(row?.props.rightElement.props.value).toBe(false);
        row?.props.rightElement.props.onValueChange(true);

        expect(setBackgroundServiceModeMock).toHaveBeenCalledWith('at-login');
    });

    it('says plainly what turning the background service off costs', async () => {
        const { DesktopSettingsSection } = await import('./DesktopSettingsSection');
        const screen = await renderSettingsView(<DesktopSettingsSection />);
        const row = screen.findRow('settings-desktop-background-service-enabled');

        expect(row?.props.title).toBe('settingsDesktop.backgroundServiceTitle');
        expect(row?.props.subtitle).toBe('settingsDesktop.backgroundServiceSubtitle');
    });

    it('offers no switch to flip when the installed CLI cannot report the mode', async () => {
        backgroundServiceState.mode = null;
        const { DesktopSettingsSection } = await import('./DesktopSettingsSection');
        const screen = await renderSettingsView(<DesktopSettingsSection />);
        const row = screen.findRow('settings-desktop-background-service-enabled');

        expect(row?.props.rightElement.props.disabled).toBe(true);
        expect(row?.props.subtitle).toBe('settingsDesktop.backgroundServiceUnknown');
    });

    it('says the switch arrives with setup when no background service is installed yet (U12)', async () => {
        // Before setup, or after the user declined it, nothing is installed: the CLI is not
        // failing to report a mode, there is simply no service to report on.
        backgroundServiceState.mode = null;
        backgroundServiceState.installed = false;
        const { DesktopSettingsSection } = await import('./DesktopSettingsSection');
        const screen = await renderSettingsView(<DesktopSettingsSection />);
        const row = screen.findRow('settings-desktop-background-service-enabled');

        expect(row?.props.rightElement.props.disabled).toBe(true);
        expect(row?.props.subtitle).toBe('settingsDesktop.backgroundServiceNotSetUp');
    });

    it('shows a failed change in words, never the raw error (U12)', async () => {
        backgroundServiceState.error = 'Error: spawn happier ENOENT';
        const { DesktopSettingsSection } = await import('./DesktopSettingsSection');
        const screen = await renderSettingsView(<DesktopSettingsSection />);
        const row = screen.findRow('settings-desktop-background-service-enabled');

        expect(row?.props.subtitle).toBe('settingsDesktop.backgroundServiceChangeFailed');
    });
});
