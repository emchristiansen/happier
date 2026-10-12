import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { CustomModalChromeConfig } from '@/modal/types';
import { SessionReminderDateTimeModal } from './SessionReminderDateTimeModal';

const native = vi.hoisted(() => ({
    platform: 'ios' as 'ios' | 'android',
    components: new Set<string>(),
    modules: new Set<string>(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: native.platform }, {
        Platform: { get OS() { return native.platform; } },
        UIManager: { hasViewManagerConfig: (name: string) => native.components.has(name) },
        TurboModuleRegistry: { get: (name: string) => native.modules.has(name) ? {} : null },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/ui/text/Text', async () => {
    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});

// Vitest is a Node host; use Metro's native platform selection while retaining
// the real adapter and its capability decision, not a fake picker implementation.
vi.mock('./SessionReminderPicker', () => vi.importActual('./SessionReminderPicker.native'));

// This native SDK evaluates enforcing lookups when loaded. Model that real system
// boundary so loading it on an older binary is itself an observable failure.
vi.mock('@react-native-community/datetimepicker', async () => {
    const available = native.platform === 'ios'
        ? native.components.has('RNDateTimePicker')
        : ['RNCDatePicker', 'RNCTimePicker', 'RNCMaterialDatePicker', 'RNCMaterialTimePicker']
            .every((name) => native.modules.has(name));
    if (!available) throw new Error('Picker native module is absent in the installed binary');
    return {
        default: (props: React.Attributes & Record<string, unknown>) => React.createElement('NativeDateTimePicker', props),
    };
});

beforeEach(() => {
    native.components.clear();
    native.modules.clear();
});

describe('SessionReminderPicker on installed native binaries', () => {
    it.each(['ios', 'android'] as const)('keeps manual reminder submission usable on an older %s app', async (platform) => {
        native.platform = platform;
        const setChrome = vi.fn<(value: CustomModalChromeConfig | null) => void>();
        const onResolve = vi.fn();
        const onClose = vi.fn();
        const screen = await renderScreen(<SessionReminderDateTimeModal
            nowMs={new Date(2026, 8, 30, 12).getTime()}
            onResolve={onResolve} onClose={onClose} setChrome={setChrome}
        />);
        expect(screen.findByTestId('session-reminder-date-picker-button') === null).toBe(true);
        expect(screen.findByTestId('session-reminder-time-picker-button') === null).toBe(true);
        await act(async () => {
            screen.changeTextByTestId('session-reminder-date-input', '2026-10-01');
            screen.changeTextByTestId('session-reminder-time-input', '14:25');
        });
        const footer = await renderScreen(<>{setChrome.mock.lastCall?.[0]?.footer}</>);
        const buttons = footer.findAll((node) => typeof node.type === 'string' && node.props.accessibilityRole === 'button');
        expect(buttons).toHaveLength(2);
        await act(async () => buttons[1].props.onPress());
        expect(onResolve).toHaveBeenCalledWith({ remindAt: new Date(2026, 9, 1, 14, 25).getTime() });
        expect(onClose).toHaveBeenCalledOnce();
    });

    it.each(['ios', 'android'] as const)('does not load the unavailable SDK on an older %s binary', async (platform) => {
        native.platform = platform;
        const { SessionReminderPicker } = await import('./SessionReminderPicker.native');
        const screen = await renderScreen(<SessionReminderPicker
            mode="date" anchorRef={{ current: null }} value={new Date(2026, 8, 30, 9)}
            minimumDate={new Date(2026, 8, 30)} accentColor="test-accent"
            onChange={vi.fn()} onDismiss={vi.fn()}
        />);
        expect(screen.tree.toJSON()).toBeNull();
    });

    it('does not load Android SDK 8.4.4 when its eagerly required material modules are missing', async () => {
        native.platform = 'android';
        native.modules.add('RNCDatePicker');
        native.modules.add('RNCTimePicker');
        const { SessionReminderPicker } = await import('./SessionReminderPicker.native');
        const screen = await renderScreen(<SessionReminderPicker
            mode="date" anchorRef={{ current: null }} value={new Date(2026, 8, 30, 9)}
            minimumDate={new Date(2026, 8, 30)} accentColor="test-accent"
            onChange={vi.fn()} onDismiss={vi.fn()}
        />);
        expect(screen.tree.toJSON()).toBeNull();
    });

    it('preserves Android selection and dismissal when all native modules are installed', async () => {
        native.platform = 'android';
        for (const name of ['RNCDatePicker', 'RNCTimePicker', 'RNCMaterialDatePicker', 'RNCMaterialTimePicker']) native.modules.add(name);
        const { SessionReminderPicker } = await import('./SessionReminderPicker.native');
        const onChange = vi.fn();
        const onDismiss = vi.fn();
        const screen = await renderScreen(<SessionReminderPicker
            mode="time" anchorRef={{ current: null }} value={new Date(2026, 8, 30, 9)}
            minimumDate={new Date(2026, 8, 30)} accentColor="test-accent"
            onChange={onChange} onDismiss={onDismiss}
        />);
        const selected = new Date(2026, 8, 30, 14, 25);
        await act(async () => { await import('@react-native-community/datetimepicker'); });
        await act(async () => screen.findByType('NativeDateTimePicker').props.onChange({ type: 'set' }, selected));
        expect(onChange).toHaveBeenCalledWith(selected);
        expect(onDismiss).toHaveBeenCalledOnce();
        onChange.mockClear();
        onDismiss.mockClear();
        await act(async () => screen.findByType('NativeDateTimePicker').props.onChange({ type: 'dismissed' }));
        expect(onChange).not.toHaveBeenCalled();
        expect(onDismiss).toHaveBeenCalledOnce();
    });

    it('opens the iOS picker through the real modal and keeps it open after selection', async () => {
        native.platform = 'ios';
        native.components.add('RNDateTimePicker');
        const setChrome = vi.fn<(value: CustomModalChromeConfig | null) => void>();
        const screen = await renderScreen(<SessionReminderDateTimeModal
            nowMs={new Date(2026, 8, 30, 12).getTime()}
            onResolve={vi.fn()} onClose={vi.fn()} setChrome={setChrome}
        />);
        await screen.pressByTestIdAsync('session-reminder-date-picker-button');
        await act(async () => { await import('@react-native-community/datetimepicker'); });
        const picker = screen.findByType('NativeDateTimePicker');
        expect(picker.props.display).toBe('inline');
        await act(async () => picker.props.onChange({ type: 'set' }, new Date(2026, 9, 2, 9)));
        expect(screen.findByTestId('session-reminder-date-input')?.props.value).toBe('2026-10-02');
        expect(screen.findAllByType('NativeDateTimePicker')).toHaveLength(1);
    });
});
