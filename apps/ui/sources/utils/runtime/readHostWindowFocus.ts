/** Physical window focus, shared by local desktop presence and sync publication. */
export function readHostWindowFocus(): boolean | undefined {
    const doc = (globalThis as unknown as { document?: { hasFocus?: () => boolean } }).document;
    if (typeof doc?.hasFocus !== 'function') return undefined;
    try {
        return doc.hasFocus();
    } catch {
        // The host cannot establish focus: callers preserve their existing unknown-state policy.
        return undefined;
    }
}
