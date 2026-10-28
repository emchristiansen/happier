import { describe, expect, it } from 'vitest';

import {
    applyTailDiscontinuityOlderPage,
    applyTailDiscontinuityOpaqueOlderPage,
    applyTailDiscontinuityOpaqueForwardPage,
    openTailDiscontinuityFromSnapshot,
    openTailDiscontinuityFromOpaqueSnapshot,
} from './sessionMessagesTailDiscontinuity';

describe('openTailDiscontinuityFromSnapshot', () => {
    it('opens a discontinuity when the snapshot island starts above the contiguous prefix', () => {
        const record = openTailDiscontinuityFromSnapshot({
            prev: null,
            prefixMaxSeq: 410,
            snapshotMinSeq: 1951,
        });
        expect(record).toEqual({ kind: 'seq', prefixMaxSeq: 410, walkCursor: 1951 });
    });

    it('does not open on a contiguous or overlapping snapshot', () => {
        expect(openTailDiscontinuityFromSnapshot({
            prev: null,
            prefixMaxSeq: 410,
            snapshotMinSeq: 411,
        })).toBeNull();
        expect(openTailDiscontinuityFromSnapshot({
            prev: null,
            prefixMaxSeq: 410,
            snapshotMinSeq: 380,
        })).toBeNull();
    });

    it('does not open when there was no prior materialized content', () => {
        expect(openTailDiscontinuityFromSnapshot({
            prev: null,
            prefixMaxSeq: 0,
            snapshotMinSeq: 1951,
        })).toBeNull();
    });

    it('keeps the deepest prefix on a stacked reset while a discontinuity is already open', () => {
        const first = openTailDiscontinuityFromSnapshot({
            prev: null,
            prefixMaxSeq: 410,
            snapshotMinSeq: 1951,
        });
        // A second large gap opens while the first hole is still unfilled: the island head
        // advanced to 2600, the new snapshot starts at 5000. The walk restarts from the new
        // island but must still bridge all the way down to the ORIGINAL prefix.
        const second = openTailDiscontinuityFromSnapshot({
            prev: first,
            prefixMaxSeq: 2600,
            snapshotMinSeq: 5000,
        });
        expect(second).toEqual({ kind: 'seq', prefixMaxSeq: 410, walkCursor: 5000 });
    });

    it('keeps the open record when a later snapshot is contiguous with the island', () => {
        const first = openTailDiscontinuityFromSnapshot({
            prev: null,
            prefixMaxSeq: 410,
            snapshotMinSeq: 1951,
        });
        const unchanged = openTailDiscontinuityFromSnapshot({
            prev: first,
            prefixMaxSeq: 2000,
            snapshotMinSeq: 1990,
        });
        expect(unchanged).toBe(first);
    });
});

describe('opaque tail discontinuity', () => {
    const open = () => openTailDiscontinuityFromOpaqueSnapshot({
        prev: null,
        prefixMessageIds: ['source-prefix'],
        prefixMaterializedMessageIds: ['old-tool', 'old-text'],
        snapshotMessageIds: ['source-result', 'source-tail'],
        snapshotMaterializedMessageIds: ['old-tool', 'tail-text'],
        nextCursor: 'older-tail',
    })!;

    it('reveals later visible forward rows after an absorbed snapshot without changing the recovery walk', () => {
        const gap = openTailDiscontinuityFromOpaqueSnapshot({
            prev: null, prefixMessageIds: ['old-source'], prefixMaterializedMessageIds: ['old-tool'],
            snapshotMessageIds: ['absorbed-result'], snapshotMaterializedMessageIds: ['old-tool'], nextCursor: 'older-gap',
        })!;
        expect(applyTailDiscontinuityOpaqueForwardPage({ prev: gap, pageMaterializedMessageIds: ['old-tool'] })).toBe(gap);
        const revealed = applyTailDiscontinuityOpaqueForwardPage({ prev: gap, pageMaterializedMessageIds: ['old-tool', 'new-text', 'new-text'] });
        expect(revealed).toEqual({ ...gap, boundaryMessageIds: ['new-text'] });
        expect(applyTailDiscontinuityOpaqueForwardPage({ prev: revealed, pageMaterializedMessageIds: ['later-text'] })).toBe(revealed);
    });

    it('keeps source overlap separate from an absorbed materialized tool row', () => {
        const gap = open();
        expect(gap.boundaryMessageIds).toEqual(['tail-text']);
        const advanced = applyTailDiscontinuityOpaqueOlderPage({
            prev: gap,
            pageMessageIds: ['source-other-result'],
            pageMaterializedMessageIds: ['old-tool'],
            nextCursor: 'older-middle',
        });
        expect(advanced).toMatchObject({ walkCursor: 'older-middle', boundaryMessageIds: ['tail-text'] });
        expect(applyTailDiscontinuityOpaqueOlderPage({
            prev: advanced!, pageMessageIds: ['source-prefix'], pageMaterializedMessageIds: ['old-text'], nextCursor: 'original-prefix',
        })).toBeNull();
    });

    it('preserves the original prefix across stacked islands and terminal missing history', () => {
        const first = open();
        const stacked = openTailDiscontinuityFromOpaqueSnapshot({
            prev: first,
            prefixMessageIds: ['source-tail'],
            prefixMaterializedMessageIds: ['old-tool', 'old-text', 'tail-text'],
            snapshotMessageIds: ['source-new-tail'],
            snapshotMaterializedMessageIds: ['new-tail'],
            nextCursor: 'older-new-tail',
        })!;
        expect(stacked).toMatchObject({ prefixMessageIds: ['source-prefix'], prefixMaterializedMessageIds: ['old-tool', 'old-text'], boundaryMessageIds: ['new-tail'] });
        const terminal = applyTailDiscontinuityOpaqueOlderPage({
            prev: stacked, pageMessageIds: [], pageMaterializedMessageIds: [], nextCursor: null,
        });
        expect(terminal).toMatchObject({ walkCursor: null, boundaryMessageIds: ['new-tail'], prefixMessageIds: ['source-prefix'] });
    });

    it('does not publish progress from a repeated opaque cursor unless source overlap proves the bridge', () => {
        const gap = open();
        expect(applyTailDiscontinuityOpaqueOlderPage({
            prev: gap, pageMessageIds: ['source-tail'], pageMaterializedMessageIds: ['tail-text'], nextCursor: gap.walkCursor,
        })).toBe(gap);
        expect(applyTailDiscontinuityOpaqueOlderPage({
            prev: gap, pageMessageIds: ['source-prefix'], pageMaterializedMessageIds: ['old-text'], nextCursor: gap.walkCursor,
        })).toBeNull();
    });

    it('does not open on source overlap and does not invent a boundary for invisible snapshot rows', () => {
        expect(openTailDiscontinuityFromOpaqueSnapshot({
            prev: null, prefixMessageIds: ['same'], prefixMaterializedMessageIds: ['same-row'],
            snapshotMessageIds: ['same', 'new'], snapshotMaterializedMessageIds: ['same-row', 'new-row'], nextCursor: 'older',
        })).toBeNull();
        expect(openTailDiscontinuityFromOpaqueSnapshot({
            prev: null, prefixMessageIds: ['old'], prefixMaterializedMessageIds: ['old-row'],
            snapshotMessageIds: ['invisible'], snapshotMaterializedMessageIds: [], nextCursor: 'older',
        })).toMatchObject({ boundaryMessageIds: [] });
    });
});

describe('applyTailDiscontinuityOlderPage', () => {
    const record = { kind: 'seq', prefixMaxSeq: 410, walkCursor: 1951 } as const;

    it('advances the walk cursor from a fetched older page', () => {
        expect(applyTailDiscontinuityOlderPage({
            prev: record,
            pageMinSeq: 1801,
            nextBeforeSeq: 1801,
        })).toEqual({ kind: 'seq', prefixMaxSeq: 410, walkCursor: 1801 });
    });

    it('prefers the server cursor when it is provided and lower', () => {
        expect(applyTailDiscontinuityOlderPage({
            prev: record,
            pageMinSeq: 1810,
            nextBeforeSeq: 1801,
        })).toEqual({ kind: 'seq', prefixMaxSeq: 410, walkCursor: 1801 });
    });

    it('closes when the walk bridges the prefix', () => {
        expect(applyTailDiscontinuityOlderPage({
            prev: record,
            pageMinSeq: 411,
            nextBeforeSeq: 411,
        })).toBeNull();
        expect(applyTailDiscontinuityOlderPage({
            prev: record,
            pageMinSeq: 380,
            nextBeforeSeq: 380,
        })).toBeNull();
    });

    it('closes on an empty page (nothing exists below the walk any more)', () => {
        expect(applyTailDiscontinuityOlderPage({
            prev: record,
            pageMinSeq: null,
            nextBeforeSeq: null,
        })).toBeNull();
    });

    it('never raises the walk cursor', () => {
        expect(applyTailDiscontinuityOlderPage({
            prev: record,
            pageMinSeq: 1990,
            nextBeforeSeq: null,
        })).toEqual(record);
    });
});
