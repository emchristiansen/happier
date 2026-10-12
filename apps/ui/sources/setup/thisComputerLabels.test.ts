import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import { formatShortAccountId } from './thisComputerLabels';

describe('formatShortAccountId', () => {
    it('never ends in an ellipsis, so a sentence that ends on the label never reads "…."', () => {
        // "Connecting this computer to relay as cmuijuzr…." — the label sits before a period in
        // every locale's setup, drift and consent sentences.
        const label = formatShortAccountId('cmuijuzr9x0000abcd1234');
        expect(label.endsWith('…')).toBe(false);
        expect(`as ${label}.`).not.toContain('….');
        // Still a visibly shortened id that tells two accounts apart.
        expect(label).toContain('…');
        expect(formatShortAccountId('cmuijuzr9x0000abcd1234')).not.toBe(formatShortAccountId('cmuijuzr9x0000abcd9999'));
    });

    it('keeps a short id whole', () => {
        expect(formatShortAccountId('  acct_1  ')).toBe('acct_1');
    });
});
