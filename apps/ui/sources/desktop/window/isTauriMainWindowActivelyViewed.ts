import { readHostWindowFocus } from '@/utils/runtime/readHostWindowFocus';
import { isTauriDesktop } from '@/utils/platform/tauri';

export function isTauriMainWindowActivelyViewed(): boolean {
    if (!isTauriDesktop()) {
        return false;
    }

    const doc = (globalThis as unknown as {
        document?: {
            visibilityState?: string;
            hasFocus?: () => boolean;
        };
    }).document;

    if (doc?.visibilityState === 'hidden') {
        return false;
    }

    return readHostWindowFocus() ?? true;
}
