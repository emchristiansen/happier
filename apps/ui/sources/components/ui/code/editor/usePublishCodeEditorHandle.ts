import * as React from 'react';

import type { CodeEditorHandle } from './codeEditorTypes';

/** Outgoing transition layers may unmount after the incoming editor publishes. */
export function usePublishCodeEditorHandle(
    editorRef: React.MutableRefObject<CodeEditorHandle | null>,
): React.RefCallback<CodeEditorHandle> {
    const publishedHandle = React.useRef<CodeEditorHandle | null>(null);
    return React.useCallback((handle: CodeEditorHandle | null) => {
        if (handle !== null || editorRef.current === publishedHandle.current) {
            editorRef.current = handle;
        }
        publishedHandle.current = handle;
    }, [editorRef]);
}
