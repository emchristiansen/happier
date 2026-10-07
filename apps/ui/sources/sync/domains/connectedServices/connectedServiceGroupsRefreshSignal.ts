import * as React from 'react';

let connectedServiceGroupsRefreshVersion = 0;
const connectedServiceGroupsRefreshListeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
    connectedServiceGroupsRefreshListeners.add(listener);
    return () => connectedServiceGroupsRefreshListeners.delete(listener);
}

function getSnapshot(): number {
    return connectedServiceGroupsRefreshVersion;
}

export function invalidateConnectedServiceGroupsRefreshSignal(): void {
    connectedServiceGroupsRefreshVersion += 1;
    for (const listener of connectedServiceGroupsRefreshListeners) listener();
}

export function useConnectedServiceGroupsRefreshSignal(): number {
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
