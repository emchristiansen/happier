import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
type MockProps = React.Attributes & Record<string, unknown>;

vi.mock('@/modal/components/card/useModalCardChrome', () => ({ useModalCardChrome: () => undefined }));
vi.mock('@/components/ui/buttons/RoundButton', () => ({ RoundButton: (props: MockProps) => React.createElement('RoundButton', props) }));
vi.mock('@/components/ui/icons/Icon', () => ({ Icon: (props: MockProps) => React.createElement('Icon', props) }));
vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: MockProps) => React.createElement('Text', props),
    TextInput: (props: MockProps) => React.createElement('TextInput', props),
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));

describe('SessionReminderPresetManagerModal', () => {
    it('caps editable labels at the synced preset schema boundary', async () => {
        const { SessionReminderPresetManagerModal } = await import('./SessionReminderPresetManagerModal');
        const screen = await renderScreen(<SessionReminderPresetManagerModal
            presets={[{ rule: { kind: 'relative_day', daysAhead: 1, minuteOfDay: 540 }, label: 'Tomorrow' }]}
            onResolve={vi.fn()}
            onClose={vi.fn()}
            setChrome={vi.fn()}
        />);

        expect(screen.findByType('TextInput').props.maxLength).toBe(80);
    });
});
