import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const { View, Text, ScrollView } = await import('react-native');
    const mock = createReanimatedModuleMock();
    return { ...mock, default: { ...mock.default, View, Text, ScrollView }, View, Text, ScrollView };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const theme = { colors: { border: { default: '#ddd' }, surface: { inset: '#eee', base: '#fff' }, text: { primary: '#111' } } };

afterEach(async () => {
    await standardCleanup();
});

it('maps a selected diff area and retains trailing actions for a single area', async () => {
    const { ChangedFilesReviewDiffAreaSelector } = await import('./ChangedFilesReviewDiffAreaSelector');
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const onChange = vi.fn();
    const labels = { pending: 'Pending', included: 'Included', both: 'Combined' };
    const multiAreaScreen = await renderScreen(
        <ChangedFilesReviewDiffAreaSelector theme={theme} diffArea="both" availableModes={['included', 'pending', 'both']} labels={labels} onChange={onChange} />,
    );
    const menu = multiAreaScreen.findByType(DropdownMenu);
    act(() => menu.props.onSelect('pending'));
    expect(onChange).toHaveBeenCalledWith('pending');

    const singleAreaScreen = await renderScreen(
        <ChangedFilesReviewDiffAreaSelector
            theme={theme}
            diffArea="pending"
            availableModes={['pending']}
            labels={labels}
            onChange={onChange}
            trailingElement={<TrailingAction testID="trailing" />}
        />,
    );
    expect(singleAreaScreen.findByTestId('trailing')).not.toBeNull();
    expect(singleAreaScreen.findByTestId('scm-review-diff-area-menu')).toBeNull();
});

function TrailingAction(props: Readonly<{ testID: string }>) {
    return React.createElement('TrailingAction', props);
}
