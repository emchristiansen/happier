import { describe, expect, it } from 'vitest';

import { resolvePreferredPublicReleaseRingLabelForApp } from './currentAppVariant';

describe('resolvePreferredPublicReleaseRingLabelForApp', () => {
    it('uses the public dev identity ring even when its logical runtime variant is preview', () => {
        expect(resolvePreferredPublicReleaseRingLabelForApp({
            identityVariant: 'publicdev',
            variant: 'preview',
        })).toBe('dev');
    });

    it('falls back to the logical runtime variant when an older build has no identity ring', () => {
        expect(resolvePreferredPublicReleaseRingLabelForApp({
            identityVariant: undefined,
            variant: 'preview',
        })).toBe('preview');
    });
});
