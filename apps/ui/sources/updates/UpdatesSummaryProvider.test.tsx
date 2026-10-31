import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({ importOriginal, overrides: {} });
});

// Counts the one classification while delegating to the real implementation.
vi.mock('./items/buildUpdatesSummary', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./items/buildUpdatesSummary')>();
    return { ...actual, buildUpdatesSummary: vi.fn(actual.buildUpdatesSummary) };
});

import { buildUpdatesSummary } from './items/buildUpdatesSummary';
import { UpdatesSummaryProvider, useSharedUpdatesSummary } from './useUpdatesSummary';

const seen: unknown[] = [];

function Entry(): React.ReactElement | null {
    seen.push(useSharedUpdatesSummary());
    return null;
}

describe('UpdatesSummaryProvider', () => {
    it('classifies once for every always-mounted entry (pill, rail, header, Settings, tray)', async () => {
        await renderScreen(
            <UpdatesSummaryProvider>
                <Entry />
                <Entry />
                <Entry />
                <Entry />
                <Entry />
            </UpdatesSummaryProvider>,
        );
        expect(vi.mocked(buildUpdatesSummary)).toHaveBeenCalledTimes(1);
        expect(new Set(seen).size).toBe(1);
    });
});
