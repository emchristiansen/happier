import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { CustomModalChromeConfig } from '@/modal/types';
import { SessionReminderDateTimeModal } from './SessionReminderDateTimeModal';

vi.mock('@/components/ui/text/Text', async () => {
    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

describe('SessionReminderDateTimeModal', () => {
    it('saves an optional preset only after opt-in, preserving the chosen local date and time', async () => {
        const setChrome = vi.fn<(value: CustomModalChromeConfig | null) => void>();
        const onResolve = vi.fn();
        const onClose = vi.fn();
        const screen = await renderScreen(<SessionReminderDateTimeModal
            nowMs={new Date(2026, 8, 30, 12).getTime()}
            onResolve={onResolve} onClose={onClose} setChrome={setChrome}
        />);

        await act(async () => screen.find((node) => typeof node.props.onValueChange === 'function').props.onValueChange(true));
        const footer = await renderScreen(<>{setChrome.mock.lastCall?.[0]?.footer}</>);
        const buttons = footer.findAll((node) => typeof node.type === 'string' && node.props.accessibilityRole === 'button');
        await act(async () => buttons[1].props.onPress());
        expect(onResolve).toHaveBeenCalledWith({
            remindAt: new Date(2026, 9, 1, 9).getTime(),
            preset: { rule: { kind: 'relative_day', daysAhead: 1, minuteOfDay: 540 } },
        });
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('rejects invalid manual dates and preserves cancellation', async () => {
        const setChrome = vi.fn<(value: CustomModalChromeConfig | null) => void>();
        const onResolve = vi.fn();
        const onClose = vi.fn();
        const screen = await renderScreen(<SessionReminderDateTimeModal
            nowMs={new Date(2026, 8, 30, 12).getTime()}
            onResolve={onResolve} onClose={onClose} setChrome={setChrome}
        />);
        await act(async () => screen.changeTextByTestId('session-reminder-date-input', '2026-02-30'));
        const footer = await renderScreen(<>{setChrome.mock.lastCall?.[0]?.footer}</>);
        const buttons = footer.findAll((node) => typeof node.type === 'string' && node.props.accessibilityRole === 'button');
        expect(buttons[1].props.disabled).toBe(true);
        await act(async () => buttons[0].props.onPress());
        expect(onResolve).toHaveBeenCalledWith(null);
        expect(onClose).toHaveBeenCalledOnce();
    });
});
