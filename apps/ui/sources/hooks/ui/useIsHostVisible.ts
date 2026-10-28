import * as React from 'react';

import { isHostVisible, subscribeToRuntimeActiveChange } from '@/utils/runtime/isRuntimeActive';

/**
 * Whether the window this UI is in is on screen, for surfaces that must stop moving when it is
 * not (`apps/ui/AGENTS.md`: every animation loop declares its stop condition).
 *
 * Reads the canonical lifecycle owner rather than attaching another `visibilitychange` listener,
 * so a surface cannot end up with its own idea of what "hidden" means.
 */
export function useIsHostVisible(): boolean {
    return React.useSyncExternalStore(subscribeToRuntimeActiveChange, isHostVisible, () => true);
}
