import { randomUUID } from 'node:crypto';
import { MessagePort } from 'node:worker_threads';

import type {
    CodexAppServerPrivateIoEvent,
    CodexAppServerPrivateIoOwner,
} from '../appServer/client/createCodexAppServerClient';

const wire = 'private-caller-reader/v1';

export class PrivateCallerReaderError extends Error {
    constructor(readonly code: 'reader_not_authorized' | 'reader_closed' | 'receiver_failed', options?: ErrorOptions) {
        super(`Private caller ${code}; diagnostic values are not shown`, options);
        this.name = 'PrivateCallerReaderError';
    }
}

export type PrivateCallerReaderOwner = CodexAppServerPrivateIoOwner & Readonly<{
    subscribe: (receiver: unknown) => Readonly<{ deliver: (event: CodexAppServerPrivateIoEvent) => void }>;
    revoke: () => void;
    close: () => Promise<void>;
}>;

export type PrivateCallerReceiverTerminal =
    | Readonly<{ kind: 'closed' }>
    | Readonly<{
        kind: 'failed';
        error: unknown;
        custody: Readonly<{ kind: 'captured' }> | Readonly<{ kind: 'failed'; error: unknown }>;
        notification: Readonly<{ kind: 'sent' }> | Readonly<{ kind: 'failed'; error: unknown }>;
    }>;

/** Attach the real private receiver before native startup. The endpoint itself
 * fixes the recipient; an ID, path or claimed role never selects another one.
 * Keep this handle: terminal retains the original failure even if the recorder
 * or structured clone cannot accept it. Terminal is not callback cancellation. */
export function bindPrivateCallerReceiver(
    port: MessagePort,
    receive: (event: CodexAppServerPrivateIoEvent) => void | Promise<void>,
    recording: CodexAppServerPrivateIoOwner,
): (() => void) & Readonly<{ terminal: Promise<PrivateCallerReceiverTerminal> }> {
    let queue = Promise.resolve();
    let closed = false;
    let settle!: (result: PrivateCallerReceiverTerminal) => void;
    const terminal = new Promise<PrivateCallerReceiverTerminal>((resolve) => { settle = resolve; });
    const finish = (result: PrivateCallerReceiverTerminal) => {
        if (!closed) {
            closed = true;
            port.off('message', onMessage);
            port.off('close', onClose);
            port.close();
        }
        if (result.kind === 'failed') settle(result);
        else {
            // A closed channel does not cancel a callback already running. If
            // it later fails, retain that original failure before settling.
            void queue.then(() => settle(result));
        }
    };
    const onClose = () => finish({ kind: 'closed' });
    const failed = (error: unknown) => {
        let custody: Extract<PrivateCallerReceiverTerminal, { kind: 'failed' }>['custody'];

        try {
            // Record the original value before attempting transport. Neither a
            // clone failure nor the channel's closure replaces that value.
            recording.capture({ kind: 'failure', operation: 'private receiver callback', error });
            custody = { kind: 'captured' };
        } catch (custodyError) { custody = { kind: 'failed', error: custodyError }; }
        const notification = (() => {
            try {
                port.postMessage({ wire, kind: 'failed', error });
                return { kind: 'sent' } as const;
            } catch (notificationError) { return { kind: 'failed', error: notificationError } as const; }
        })();
        // Closing the channel notifies the owner even when the full error
        // cannot cross it. The local terminal handle retains both failures.
        finish({ kind: 'failed', error, custody, notification });
    };
    const onMessage = (value: unknown) => {
        if (closed) return;
        if (!value || typeof value !== 'object' || !('wire' in value) || value.wire !== wire || !('kind' in value)) {
            finish({ kind: 'closed' });
            return;
        }
        if (value.kind === 'install' && 'nonce' in value && typeof value.nonce === 'string') {
            try { port.postMessage({ wire, kind: 'ready', nonce: value.nonce }); }
            catch (error) { failed(error); }
        } else if (value.kind === 'event' && 'sequence' in value && typeof value.sequence === 'number' && 'event' in value) {
            const { sequence, event } = value;
            // Only the opposite, retained owner can write this private port.
            queue = queue.then(async () => {
                if (closed) return;
                await receive(event as CodexAppServerPrivateIoEvent);
                if (!closed) port.postMessage({ wire, kind: 'accepted', sequence });
            }).catch(failed);
        } else {
            finish({ kind: 'closed' });
        }
    };
    port.on('message', onMessage);
    port.on('close', onClose);
    port.start();
    return Object.assign(() => finish({ kind: 'closed' }), { terminal });
}

/** Install exactly the original continuation and Eric's private receiver.
 * Readiness comes from those actual channels before this promise resolves.
 * This resource owns publication only, not a deployment or PAR admission. */
export async function createPrivateCallerReaderOwner(params: Readonly<{
    originalContinuation: MessagePort;
    eric: MessagePort;
    recording: CodexAppServerPrivateIoOwner;
    signal: AbortSignal;
}>): Promise<PrivateCallerReaderOwner> {
    const { originalContinuation, eric, recording, signal } = params;
    if (!(originalContinuation instanceof MessagePort) || !(eric instanceof MessagePort) || originalContinuation === eric) {
        throw new PrivateCallerReaderError('reader_not_authorized');
    }
    const nonce = randomUUID();
    let phase: 'installing' | 'open' | 'closing' | 'closed' = 'installing';
    let failure: PrivateCallerReaderError | undefined;
    let sequence = 0;
    let originalReady = false;
    let ericReady = false;
    let readyResolve!: () => void;
    let readyReject!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const pending = new Map<number, {
        originalAccepted: boolean;
        ericAccepted: boolean;
        done: Promise<void>;
        resolve: () => void;
        reject: (error: unknown) => void;
    }>();

    const fail = (error: PrivateCallerReaderError) => {
        if (phase === 'closed') return;
        failure = error;
        phase = 'closed';
        readyReject(error);
        for (const receipt of pending.values()) receipt.reject(error);
        originalContinuation.close();
        eric.close();
    };
    const requireOpen = () => {
        if (phase !== 'open') throw failure ?? new PrivateCallerReaderError('reader_closed');
    };
    const onReply = (port: MessagePort, value: unknown) => {
        if (phase === 'closed') return;
        if (!value || typeof value !== 'object' || !('wire' in value) || value.wire !== wire || !('kind' in value)) {
            fail(new PrivateCallerReaderError('receiver_failed'));
            return;
        }
        if (phase === 'installing' && value.kind === 'ready' && 'nonce' in value && value.nonce === nonce) {
            if (port === originalContinuation) originalReady = true;
            if (port === eric) ericReady = true;
            if (originalReady && ericReady) { phase = 'open'; readyResolve(); }
        } else if (value.kind === 'accepted' && 'sequence' in value && typeof value.sequence === 'number') {
            const receipt = pending.get(value.sequence);
            if (!receipt) { fail(new PrivateCallerReaderError('receiver_failed')); return; }
            if (port === originalContinuation) receipt.originalAccepted = true;
            if (port === eric) receipt.ericAccepted = true;
            if (receipt.originalAccepted && receipt.ericAccepted) {
                receipt.resolve();
                pending.delete(value.sequence);
            }
        } else {
            fail(new PrivateCallerReaderError('receiver_failed', {
                cause: 'error' in value ? value.error : undefined,
            }));
        }
    };
    const originalReply = (value: unknown) => onReply(originalContinuation, value);
    const ericReply = (value: unknown) => onReply(eric, value);
    const receiverClosed = () => fail(new PrivateCallerReaderError('reader_closed'));
    const receiverFailed = (error: unknown) => fail(new PrivateCallerReaderError('receiver_failed', { cause: error }));
    const abort = () => fail(new PrivateCallerReaderError('reader_closed', { cause: signal.reason }));
    const cleanup = () => {
        signal.removeEventListener('abort', abort);
        originalContinuation.off('message', originalReply);
        eric.off('message', ericReply);
        originalContinuation.off('close', receiverClosed);
        eric.off('close', receiverClosed);
        originalContinuation.off('messageerror', receiverFailed);
        eric.off('messageerror', receiverFailed);
        originalContinuation.close();
        eric.close();
    };
    originalContinuation.on('message', originalReply);
    eric.on('message', ericReply);
    originalContinuation.on('close', receiverClosed);
    eric.on('close', receiverClosed);
    originalContinuation.on('messageerror', receiverFailed);
    eric.on('messageerror', receiverFailed);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else {
        originalContinuation.start();
        eric.start();
        originalContinuation.postMessage({ wire, kind: 'install', nonce });
        eric.postMessage({ wire, kind: 'install', nonce });
    }
    try { await ready; }
    catch (error) { cleanup(); throw error; }

    const deliver = (port: MessagePort, event: CodexAppServerPrivateIoEvent, ordinal: number) => {
        requireOpen();
        if (port !== originalContinuation && port !== eric) throw new PrivateCallerReaderError('reader_not_authorized');
        port.postMessage({ wire, kind: 'event', sequence: ordinal, event });
    };
    const capture = (event: CodexAppServerPrivateIoEvent) => {
        try {
            // Full private custody precedes decoding or receiver publication.
            recording.capture(event);
            // The original producer still owns shutdown output after audience
            // loss. Keep its custody without admitting another publication.
            if (phase !== 'open') return;
            const ordinal = ++sequence;
            let resolve!: () => void;
            let reject!: (error: unknown) => void;
            const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
            // Keep the error for flush even when failure precedes its caller.
            void done.catch((error: unknown) => {
                failure ??= new PrivateCallerReaderError('receiver_failed', { cause: error });
            });
            pending.set(ordinal, { originalAccepted: false, ericAccepted: false, done, resolve, reject });
            deliver(originalContinuation, event, ordinal);
            deliver(eric, event, ordinal);
        } catch (error) {
            const terminal = error instanceof PrivateCallerReaderError ? error
                : new PrivateCallerReaderError('receiver_failed', { cause: error });
            fail(terminal);
            throw terminal;
        }
    };
    const flush = async () => {
        let deliveryFailure: unknown = failure;
        try { await Promise.all([...pending.values()].map((receipt) => receipt.done)); }
        catch (error) { deliveryFailure = error; }
        try { await recording.flush(); }
        catch (error) {
            if (deliveryFailure) throw new AggregateError([deliveryFailure, error], 'Private reader delivery and custody failed; values not shown');
            throw error;
        }
        if (deliveryFailure) throw deliveryFailure;
        if (failure) throw failure;
    };
    return Object.freeze({
        capture,
        flush,
        subscribe(receiver: unknown) {
            requireOpen();
            if (receiver !== originalContinuation && receiver !== eric) throw new PrivateCallerReaderError('reader_not_authorized');
            return Object.freeze({ deliver(event: CodexAppServerPrivateIoEvent) { requireOpen(); capture(event); } });
        },
        revoke: abort,
        async close() {
            if (phase === 'open') phase = 'closing';
            try { await flush(); }
            finally {
                phase = 'closed';
                cleanup();
            }
        },
    });
}
