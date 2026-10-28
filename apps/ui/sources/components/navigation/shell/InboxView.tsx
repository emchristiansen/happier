import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Header } from '@/components/navigation/Header';
import { InboxContent } from '@/components/inbox/InboxContent';
import {
    useInboxContentModel,
    type InboxContentModel,
} from '@/components/inbox/useInboxContentModel';
import { useSessionScreenIsFocused } from '@/components/sessions/shell/useSessionScreenIsFocused';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
    },
    headerTitle: {
        fontSize: 17,
        color: theme.colors.chrome.header.foreground,
        ...Typography.default('semiBold'),
    },
    scrollContent: {
        flexGrow: 1,
        width: '100%',
        alignSelf: 'center',
    },
}));

function InboxHeaderTitle() {
    return <Text style={styles.headerTitle}>{t('tabs.inbox')}</Text>;
}

const InboxViewFrame = React.memo(function InboxViewFrame(props: Readonly<{ children: React.ReactNode }>) {
    const contentMaxWidth = useLayoutMaxWidth();
    const scrollContentStyle = React.useMemo(
        () => [styles.scrollContent, { maxWidth: contentMaxWidth }],
        [contentMaxWidth],
    );
    return (
        <View style={styles.container}>
            <Header
                title={<InboxHeaderTitle />}
                headerLeft={() => null}
                headerRight={() => null}
                headerShadowVisible={false}
                headerTransparent
            />
            <ScrollView contentContainerStyle={scrollContentStyle}>
                {props.children}
            </ScrollView>
        </View>
    );
});

const FocusedInboxContent = React.memo(function FocusedInboxContent(props: Readonly<{
    onModel: (model: InboxContentModel) => void;
}>) {
    const model = useInboxContentModel();
    React.useLayoutEffect(() => {
        props.onModel(model);
    }, [model, props.onModel]);
    return <InboxContent model={model} presentation="screen" />;
});

export const InboxView = React.memo(function InboxView() {
    const isFocused = useSessionScreenIsFocused();
    const retainedModelRef = React.useRef<InboxContentModel | null>(null);
    const handleModel = React.useCallback((nextModel: InboxContentModel) => {
        retainedModelRef.current = nextModel;
    }, []);
    const retainedModel = retainedModelRef.current;

    return (
        <>
            <InboxViewFrame>
                {isFocused ? (
                    <FocusedInboxContent onModel={handleModel} />
                ) : retainedModel ? (
                    <InboxContent model={retainedModel} presentation="screen" />
                ) : null}
            </InboxViewFrame>
        </>
    );
});
