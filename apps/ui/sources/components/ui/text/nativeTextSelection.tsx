import * as React from 'react';

const NativeTextSelectionSuppressedContext = React.createContext<boolean>(false);

/**
 * Forces native text selection off for every descendant text, overriding an explicit `selectable`.
 * For surfaces where the platform selection gesture conflicts with the surface's own gesture.
 */
export function NativeTextSelectionSuppressionScope(props: Readonly<{ suppressed: boolean; children: React.ReactNode }>) {
    return (
        <NativeTextSelectionSuppressedContext.Provider value={props.suppressed}>
            {props.children}
        </NativeTextSelectionSuppressedContext.Provider>
    );
}

/** Resolves a text node's native selectability under the nearest suppression scope. */
export function useNativeTextSelectable(selectable: boolean): boolean {
    const suppressed = React.useContext(NativeTextSelectionSuppressedContext);
    return selectable && !suppressed;
}
