import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { once } from 'node:events';

import { describe, expect, it } from 'vitest';

import { validateOrdinaryReaderPath } from '@/rpc/handlers/pathSecurity';
import type { CodexAppServerPrivateIoEvent } from '../appServer/client/createCodexAppServerClient';
import { bindPrivateCallerReceiver, createPrivateCallerReaderOwner } from './privateCallerReaderOwner';

async function fixture(receive?: (event: CodexAppServerPrivateIoEvent) => Promise<void>) {
    const original = new MessageChannel();
    const eric = new MessageChannel();
    const originalEvents: CodexAppServerPrivateIoEvent[] = [];
    const ericEvents: CodexAppServerPrivateIoEvent[] = [];
    const records: CodexAppServerPrivateIoEvent[] = [];
    const stopOriginal = bindPrivateCallerReceiver(original.port2, async (event) => {
        originalEvents.push(event);
        await receive?.(event);
    });
    const stopEric = bindPrivateCallerReceiver(eric.port2, (event) => { ericEvents.push(event); });
    const controller = new AbortController();
    const owner = await createPrivateCallerReaderOwner({
        originalContinuation: original.port1, eric: eric.port1,
        recording: { capture(event) { records.push(event); }, async flush() {} },
        signal: controller.signal,
    });
    return {
        owner, original, eric, originalEvents, ericEvents, records, controller,
        async close() {
            try { await owner.close(); }
            finally { stopOriginal(); stopEric(); }
        },
    };
}

describe('private caller reader installation', () => {
    it('denies an ordinary subscriber before the first event', async () => {
        const f = await fixture();
        const ordinary = new MessageChannel();
        try {
            expect(() => f.owner.subscribe(ordinary.port1)).toThrowError(expect.objectContaining({ code: 'reader_not_authorized' }));
            expect(f.records).toEqual([]);
            expect(f.originalEvents).toEqual([]);
        } finally {
            ordinary.port1.close(); ordinary.port2.close();
            await f.close();
        }
    });

    it('delivers exact full bytes only to the two installed private receivers', async () => {
        const f = await fixture();
        try {
            const event = { kind: 'raw', stream: 'stdout', bytes: Buffer.from([0, 255, 128, 10, 65]) } as const;
            f.owner.capture(event);
            await f.owner.flush();
            expect(f.records).toEqual([event]);
            for (const events of [f.originalEvents, f.ericEvents]) {
                expect(events).toHaveLength(1);
                const delivered = events[0];
                expect(delivered.kind).toBe('raw');
                if (delivered.kind !== 'raw') throw new Error('expected raw receiver event');
                expect(Buffer.from(delivered.bytes)).toEqual(event.bytes);
            }
        } finally { await f.close(); }
    });

    it('keeps outstanding receiver work alive through close and denies new delivery', async () => {
        let accept!: () => void;
        const waiting = new Promise<void>((resolve) => { accept = resolve; });
        const f = await fixture(() => waiting);
        const delivery = f.owner.subscribe(f.original.port1);
        f.owner.capture({ kind: 'raw', stream: 'stderr', bytes: Buffer.from([255]) });
        const closing = f.close();
        expect(() => delivery.deliver({ kind: 'raw', stream: 'stdout', bytes: Buffer.from([0]) }))
            .toThrowError(expect.objectContaining({ code: 'reader_closed' }));
        accept();
        await closing;
        expect(f.originalEvents).toHaveLength(1);
        expect(f.ericEvents).toHaveLength(1);
    });

    it('revokes old delivery endpoints and never substitutes a replacement receiver', async () => {
        const f = await fixture();
        const replacement = new MessageChannel();
        const delivery = f.owner.subscribe(f.original.port1);
        try {
            f.owner.revoke();
            expect(() => delivery.deliver({ kind: 'raw', stream: 'stdout', bytes: Buffer.from([1]) }))
                .toThrowError(expect.objectContaining({ code: 'reader_closed' }));
            expect(() => f.owner.subscribe(replacement.port1)).toThrowError(expect.objectContaining({ code: 'reader_closed' }));
            expect(f.records).toEqual([]);
        } finally {
            replacement.port1.close(); replacement.port2.close();
            await expect(f.close()).rejects.toMatchObject({ code: 'reader_closed' });
        }
    });

    it('does not turn a native ID or path into a private subscription', async () => {
        const f = await fixture();
        try {
            expect(() => f.owner.subscribe({ threadId: 'original', path: '/private/source' }))
                .toThrowError(expect.objectContaining({ code: 'reader_not_authorized' }));
        } finally { await f.close(); }
    });

    it('does not finish installation when an original receiver never accepts it', async () => {
        const original = new MessageChannel();
        const eric = new MessageChannel();
        const controller = new AbortController();
        const offered = once(original.port2, 'message');
        const stopEric = bindPrivateCallerReceiver(eric.port2, () => {});
        let installed = false;
        const owner = createPrivateCallerReaderOwner({
            originalContinuation: original.port1, eric: eric.port1,
            recording: { capture() { throw new Error('no event may precede installation'); }, async flush() {} },
            signal: controller.signal,
        }).then((value) => { installed = true; return value; });
        try {
            await offered;
            expect(installed).toBe(false);
            controller.abort();
            await expect(owner).rejects.toMatchObject({ code: 'reader_closed' });
        } finally { original.port2.close(); stopEric(); }
    });

    it('ends delivery when the original private receiver closes', async () => {
        const f = await fixture();
        const closed = once(f.original.port1, 'close');
        f.original.port2.close();
        await closed;
        expect(() => f.owner.capture({ kind: 'raw', stream: 'stdout', bytes: Buffer.from([7]) }))
            .toThrowError(expect.objectContaining({ code: 'reader_closed' }));
        expect(f.records).toEqual([]);
        await expect(f.close()).rejects.toMatchObject({ code: 'reader_closed' });
    });

    it('uses the real ordinary path guard to deny private source rereads', async () => {
        const root = await mkdtemp(join(tmpdir(), 'private-reader-'));
        try {
            const domain = join(root, 'private');
            await mkdir(domain);
            await writeFile(join(domain, '.muninn-private-native-domain'), 'restriction');
            const source = join(domain, 'native.jsonl');
            await writeFile(source, Buffer.from([0, 255, 128, 10]));
            expect(validateOrdinaryReaderPath(source).valid).toBe(false);
            expect(validateOrdinaryReaderPath(join(root, 'ordinary.jsonl')).valid).toBe(true);
        } finally { await rm(root, { recursive: true, force: true }); }
    });
});
