import * as React from 'react';

import { desktopUpdater, type DesktopUpdaterSnapshot, type DesktopUpdaterStore } from './desktopUpdater';

/**
 * Subscribes to the app's one desktop updater (`desktopUpdater`). Mounting it any number of times
 * never starts another check; the store owns checking, downloading and installing.
 */
export function useDesktopUpdater(store: DesktopUpdaterStore = desktopUpdater): DesktopUpdaterSnapshot {
    return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
