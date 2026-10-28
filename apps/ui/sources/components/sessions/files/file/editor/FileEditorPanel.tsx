import * as React from 'react';
import { View } from 'react-native';

import { CodeEditor } from '@/components/ui/code/editor/CodeEditor';
import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { usePublishCodeEditorHandle } from '@/components/ui/code/editor/usePublishCodeEditorHandle';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

function FileEditorPanelImpl(props: Readonly<{
    theme: any;
    resetKey: string;
    editorRef: Readonly<React.MutableRefObject<CodeEditorHandle | null>>;
    value: string;
    language: string | null;
    onChange: (next: string) => void;
    wrapLines?: boolean;
    showLineNumbers?: boolean;
    readOnly?: boolean;
    changeDebounceMs?: number;
    bridgeMaxChunkBytes?: number;
}>) {
    const publishEditorHandle = usePublishCodeEditorHandle(props.editorRef);
    return (
        <View style={{ flex: 1, paddingHorizontal: 16, paddingVertical: 12 }}>
            <CodeEditor
                ref={publishEditorHandle}
                resetKey={props.resetKey}
                value={props.value}
                language={props.language}
                onChange={props.onChange}
                testID="file-details-editor"
                wrapLines={props.wrapLines}
                showLineNumbers={props.showLineNumbers}
                readOnly={props.readOnly}
                changeDebounceMs={props.changeDebounceMs}
                bridgeMaxChunkBytes={props.bridgeMaxChunkBytes}
            />
            <Text style={{ marginTop: 8, color: props.theme.colors.text.secondary, fontSize: 12, ...Typography.default() }}>
                {t('files.fileEditor.experimentalHint')}
            </Text>
        </View>
    );
}

export const FileEditorPanel = React.memo(FileEditorPanelImpl);
