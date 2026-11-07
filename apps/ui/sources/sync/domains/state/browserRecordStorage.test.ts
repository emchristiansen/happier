import { describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { forceCloseDatabase } from 'fake-indexeddb';
import { clearBrowserRecords, deleteBrowserRecord, listBrowserRecords, readBrowserRecord, updateBrowserRecord, writeBrowserRecord } from './browserRecordStorage';

describe('browser large-record transactions', () => {
    it('reopens an unexpectedly closed connection before clearing durable records', async () => {
        const opening = vi.spyOn(indexedDB, 'open');
        await writeBrowserRecord('closed:draft', 'private draft');
        const opened = opening.mock.results[0];
        opening.mockRestore();
        if (opened.type !== 'return') throw new Error('Expected a database open request');
        const database = opened.value.result;
        const closed = new Promise<void>((resolve) => database.addEventListener('close', () => resolve(), { once: true }));
        // @ts-expect-error fake-indexeddb declares a constructor here, but its API takes an instance.
        forceCloseDatabase(database);
        await closed;

        expect(await readBrowserRecord('closed:draft')).toBe('private draft');
        await clearBrowserRecords();
        expect(await listBrowserRecords('')).toEqual(new Map());
        await writeBrowserRecord('closed:next-account', 'new draft');
        expect(await readBrowserRecord('closed:next-account')).toBe('new draft');
    });

    it('completes an explicit local-data clear before reporting success', async () => {
        await writeBrowserRecord('clear:draft', 'draft');
        await writeBrowserRecord('clear:outbox', 'message');
        await clearBrowserRecords();
        expect(await listBrowserRecords('clear:')).toEqual(new Map());
    });
    it('persists a large record beyond Web Storage limits and deletes only its exact key', async () => {
        const value = 'large draft '.repeat(600_000);
        await writeBrowserRecord('large:scope', value);
        await writeBrowserRecord('other:scope', 'keep');
        expect(await readBrowserRecord('large:scope')).toBe(value);
        expect(await listBrowserRecords('large:')).toEqual(new Map([['large:scope', value]]));
        await deleteBrowserRecord('large:scope');
        expect(await readBrowserRecord('large:scope')).toBeUndefined();
        expect(await readBrowserRecord('other:scope')).toBe('keep');
    });

    it('serializes concurrent read-modify-write callers without losing records', async () => {
        await writeBrowserRecord('concurrent:scope', '[]');
        await Promise.all(Array.from({ length: 12 }, (_, index) => updateBrowserRecord('concurrent:scope', (raw) => ({
            value: JSON.stringify([...JSON.parse(raw ?? '[]'), index]),
            result: undefined,
        }))));
        expect(JSON.parse((await readBrowserRecord('concurrent:scope'))!)).toEqual(Array.from({ length: 12 }, (_, index) => index));
    });

    it('rejects a failed update without replacing the committed record', async () => {
        await writeBrowserRecord('failed:scope', 'valuable');
        await expect(updateBrowserRecord('failed:scope', () => { throw new Error('cannot encode'); })).rejects.toThrow('cannot encode');
        expect(await readBrowserRecord('failed:scope')).toBe('valuable');
    });
});
