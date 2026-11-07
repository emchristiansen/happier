import type { EmbeddedTerminalPaneStatus } from '@/components/terminal/embedded/types';

import { readTerminalSurfaceState } from './terminalSurfaceStateCache';

export type TerminalReaderConnection = Readonly<{
    status: EmbeddedTerminalPaneStatus;
    error: string | null;
}>;

const idleConnection: TerminalReaderConnection = { status: 'idle', error: null };
type TerminalReaderEntry = {
    owner: symbol | null;
    reconnect: ((restart: boolean) => void) | null;
    connection: TerminalReaderConnection;
    listeners: Set<() => void>;
    availabilityListeners: Set<() => void>;
};
const terminalReaders = new Map<string, TerminalReaderEntry>();
const ownedTerminalLifetimes = new Map<string, OwnedTerminalLifetime>();
const terminalReaderDisposals = new Map<string, OwnedTerminalLifetime>();

function entryFor(terminalKey: string): TerminalReaderEntry {
    let entry = terminalReaders.get(terminalKey);
    if (!entry) {
        entry = { owner: null, reconnect: null, connection: idleConnection, listeners: new Set(), availabilityListeners: new Set() };
        terminalReaders.set(terminalKey, entry);
    }
    return entry;
}

function discardUnusedEntry(terminalKey: string, entry: TerminalReaderEntry): void {
    if (!entry.owner && entry.listeners.size === 0 && entry.availabilityListeners.size === 0) {
        terminalReaders.delete(terminalKey);
    }
}

function notifyTerminalReaderAvailability(entry: TerminalReaderEntry): void {
    // Failures and exits are shared outcomes, not invitations for mounted followers
    // to repeatedly reconnect each other. A new open or explicit retry can try again.
    if (entry.connection.status === 'error' || entry.connection.status === 'exited') return;
    for (const listener of entry.availabilityListeners) listener();
}

export function claimTerminalReaderLease(terminalKey: string, ownerToken: symbol, reconnect: (restart: boolean) => void): boolean {
    // A private terminal under disposal keeps its key reserved until its close settles.
    if (terminalReaderDisposals.has(terminalKey)) return false;
    const entry = entryFor(terminalKey);
    if (entry.owner && entry.owner !== ownerToken) return false;
    const lifetime = ownedTerminalLifetimes.get(terminalKey);
    if (lifetime && lifetime.ownerToken !== ownerToken) lifetime.relinquish();
    entry.owner = ownerToken;
    entry.reconnect = reconnect;
    return true;
}

export function releaseTerminalReaderLease(terminalKey: string, ownerToken: symbol): void {
    const entry = terminalReaders.get(terminalKey);
    if (!entry || entry.owner !== ownerToken) return;
    entry.owner = null;
    entry.reconnect = null;
    notifyTerminalReaderAvailability(entry);
    discardUnusedEntry(terminalKey, entry);
}

export function isTerminalReaderDisposing(terminalKey: string): boolean {
    return terminalReaderDisposals.has(terminalKey);
}

export function hasTerminalReaderLease(terminalKey: string, ownerToken: symbol): boolean {
    return terminalReaders.get(terminalKey)?.owner === ownerToken;
}

export function reconnectTerminalReader(terminalKey: string, restart: boolean): boolean {
    const reconnect = terminalReaders.get(terminalKey)?.reconnect;
    if (!reconnect) return false;
    reconnect(restart);
    return true;
}

export function readTerminalReaderConnection(terminalKey: string): TerminalReaderConnection {
    return terminalReaders.get(terminalKey)?.connection ?? idleConnection;
}

export function publishTerminalReaderConnection(terminalKey: string, ownerToken: symbol, connection: TerminalReaderConnection): void {
    const entry = terminalReaders.get(terminalKey);
    if (!entry || entry.owner !== ownerToken) return;
    if (entry.connection.status === connection.status && entry.connection.error === connection.error) return;
    entry.connection = connection;
    for (const listener of entry.listeners) listener();
}

export function subscribeTerminalReaderConnection(terminalKey: string, listener: () => void): () => void {
    const entry = entryFor(terminalKey);
    entry.listeners.add(listener);
    return () => {
        entry.listeners.delete(listener);
        discardUnusedEntry(terminalKey, entry);
    };
}

export function subscribeTerminalReaderLeaseAvailability(terminalKey: string, listener: () => void): () => void {
    const entry = entryFor(terminalKey);
    entry.availabilityListeners.add(listener);
    return () => {
        entry.availabilityListeners.delete(listener);
        discardUnusedEntry(terminalKey, entry);
    };
}


/** A private auth surface owns only fresh results acquired during its own lifetime. */
export class OwnedTerminalLifetime {
    private state: 'active' | 'disposing' | 'disposed' | 'incomplete' | 'relinquished' = 'active';
    private pendingAcquisitions = 0;
    private pendingCloses = 0;
    private readonly ownedIds = new Set<string>();
    // An observed reused ID is not owned. It only identifies our own cached result while
    // an earlier acquisition may still settle with positive fresh-ID provenance.
    private readonly observedIds = new Set<string>();
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
            if (result && this.state !== 'relinquished') {
                this.observedIds.add(result.terminalId);
                if (!result.reused) this.ownedIds.add(result.terminalId);
            }
            if (this.state === 'disposing' || this.state === 'incomplete') this.drainDisposal();
        };
    }

    dispose(): void {
        if (!this.isActive()) return;
        const reader = terminalReaders.get(this.terminalKey)?.owner ?? null;
        const cachedId = readTerminalSurfaceState(this.terminalKey)?.terminalId;
        if ((reader && reader !== this.ownerToken) || (cachedId && !this.observedIds.has(cachedId))) {
            this.relinquish();
            return;
        }
        this.state = 'disposing';
        // Reserve before release: availability listeners run synchronously and may claim immediately.
        terminalReaderDisposals.set(this.terminalKey, this);
        // Followers must not keep presenting the private terminal as live while it closes.
        // This only takes effect while this lifetime still holds the reader lease.
        publishTerminalReaderConnection(this.terminalKey, this.ownerToken, { status: 'connecting', error: null });
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
            const entry = terminalReaders.get(this.terminalKey);
            if (entry && !entry.owner) notifyTerminalReaderAvailability(entry);
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
