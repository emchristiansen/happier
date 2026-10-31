import { readTerminalSurfaceState } from './terminalSurfaceStateCache';

type TerminalReaderListener = () => void;

const terminalReaderOwners = new Map<string, symbol>();
const ownedTerminalLifetimes = new Map<string, OwnedTerminalLifetime>();
const terminalReaderDisposals = new Map<string, OwnedTerminalLifetime>();
const terminalReaderListeners = new Map<string, Set<TerminalReaderListener>>();

function notifyTerminalReaderListeners(terminalKey: string): void {
    const listeners = terminalReaderListeners.get(terminalKey);
    if (!listeners || listeners.size === 0) {
        return;
    }
    for (const listener of listeners) {
        listener();
    }
}

export function claimTerminalReaderLease(terminalKey: string, ownerToken: symbol): boolean {
    if (terminalReaderDisposals.has(terminalKey)) return false;
    const currentOwner = terminalReaderOwners.get(terminalKey);
    if (currentOwner && currentOwner !== ownerToken) {
        return false;
    }
    const lifetime = ownedTerminalLifetimes.get(terminalKey);
    if (lifetime && lifetime.ownerToken !== ownerToken) lifetime.relinquish();
    terminalReaderOwners.set(terminalKey, ownerToken);
    return true;
}

export function releaseTerminalReaderLease(terminalKey: string, ownerToken: symbol): void {
    if (terminalReaderOwners.get(terminalKey) !== ownerToken) {
        return;
    }
    terminalReaderOwners.delete(terminalKey);
    notifyTerminalReaderListeners(terminalKey);
}

export function isTerminalReaderDisposing(terminalKey: string): boolean {
    return terminalReaderDisposals.has(terminalKey);
}

export function hasTerminalReaderLease(terminalKey: string, ownerToken: symbol): boolean {
    return terminalReaderOwners.get(terminalKey) === ownerToken;
}

export function subscribeTerminalReaderLeaseAvailability(terminalKey: string, listener: TerminalReaderListener): () => void {
    const existing = terminalReaderListeners.get(terminalKey);
    const listeners = existing ?? new Set<TerminalReaderListener>();
    listeners.add(listener);
    if (!existing) {
        terminalReaderListeners.set(terminalKey, listeners);
    }

    return () => {
        const current = terminalReaderListeners.get(terminalKey);
        if (!current) {
            return;
        }
        current.delete(listener);
        if (current.size === 0) {
            terminalReaderListeners.delete(terminalKey);
        }
    };
}


/** A private auth surface owns only fresh results acquired during its own lifetime. */
export class OwnedTerminalLifetime {
    private state: 'active' | 'disposing' | 'disposed' | 'incomplete' | 'relinquished' = 'active';
    private pendingAcquisitions = 0;
    private pendingCloses = 0;
    private readonly ownedIds = new Set<string>();
    private readonly closeStarted = new Set<string>();

    constructor(
        private readonly terminalKey: string,
        readonly ownerToken: symbol,
        private readonly close: (terminalId: string) => Promise<Readonly<{ ok: boolean }>>,
    ) {}

    isActive(): boolean {
        return this.state === 'active';
    }

    relinquish(): void {
        if (this.state !== 'active') return;
        this.state = 'relinquished';
        if (ownedTerminalLifetimes.get(this.terminalKey) === this) {
            ownedTerminalLifetimes.delete(this.terminalKey);
        }
    }

    beginAcquisition(): ((result?: Readonly<{ terminalId: string; reused: boolean }>) => void) | null {
        if (!this.isActive() || !hasTerminalReaderLease(this.terminalKey, this.ownerToken)) return null;
        ownedTerminalLifetimes.set(this.terminalKey, this);
        this.pendingAcquisitions += 1;
        let settled = false;
        return (result) => {
            if (settled) return;
            settled = true;
            this.pendingAcquisitions -= 1;
            if (result && this.state !== 'relinquished' && !result.reused) {
                this.ownedIds.add(result.terminalId);
            }
            if (this.state === 'disposing' || this.state === 'incomplete') this.drainDisposal();
        };
    }

    dispose(): void {
        if (!this.isActive()) return;
        const reader = terminalReaderOwners.get(this.terminalKey);
        const cachedId = readTerminalSurfaceState(this.terminalKey)?.terminalId;
        if ((reader && reader !== this.ownerToken) || (cachedId && !this.ownedIds.has(cachedId))) {
            this.relinquish();
            return;
        }
        this.state = 'disposing';
        // Reserve before release: availability listeners run synchronously and may claim immediately.
        terminalReaderDisposals.set(this.terminalKey, this);
        releaseTerminalReaderLease(this.terminalKey, this.ownerToken);
        this.drainDisposal();
    }

    private drainDisposal(): void {
        for (const terminalId of this.ownedIds) {
            if (this.closeStarted.has(terminalId)) continue;
            this.closeStarted.add(terminalId);
            this.pendingCloses += 1;
            // The reservation remains held across the entire asynchronous operation.
            void Promise.resolve().then(() => this.close(terminalId)).then(
                (result) => this.finishClose(result.ok),
                () => this.finishClose(false),
            );
        }
        if (this.state === 'disposing' && this.pendingAcquisitions === 0 && this.pendingCloses === 0) {
            this.state = 'disposed';
            if (ownedTerminalLifetimes.get(this.terminalKey) === this) ownedTerminalLifetimes.delete(this.terminalKey);
            if (terminalReaderDisposals.get(this.terminalKey) === this) terminalReaderDisposals.delete(this.terminalKey);
            notifyTerminalReaderListeners(this.terminalKey);
        }
    }

    private finishClose(ok: boolean): void {
        this.pendingCloses -= 1;
        if (!ok) {
            this.state = 'incomplete';
            // Keep the key reserved. An unknown close is not permission to reacquire or retry it.
            console.warn('Owned authentication terminal close did not complete; its private key remains reserved.');
        }
        if (this.state === 'disposing' || this.state === 'incomplete') this.drainDisposal();
    }
}
