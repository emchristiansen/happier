import * as React from 'react';
import { Slot } from 'expo-router';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { useArtifactsLoaded } from '@/sync/domains/state/storage';

const styles = StyleSheet.create({
    loading: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
});

export default React.memo(function PromptsLayoutRoute() {
    const artifactsLoaded = useArtifactsLoaded();
    if (!artifactsLoaded) {
        return (
            <View testID="prompts.artifacts.loading" style={styles.loading}>
                <ActivitySpinner size="small" />
            </View>
        );
    }
    return <Slot />;
});
