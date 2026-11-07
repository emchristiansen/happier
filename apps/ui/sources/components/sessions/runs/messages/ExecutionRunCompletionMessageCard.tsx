import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { ExecutionRunCompletionV1 } from '@happier-dev/protocol';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

function readStatusLabel(status: ExecutionRunCompletionV1['status']): string {
    switch (status) {
        case 'succeeded':
            return t('session.agentActivity.status.succeeded');
        case 'failed':
            return t('session.agentActivity.status.failed');
        case 'cancelled':
            return t('session.agentActivity.status.cancelled');
        case 'timeout':
            return t('session.agentActivity.status.timedOut');
    }
}

export function ExecutionRunCompletionMessageCard(props: Readonly<{
    payload: ExecutionRunCompletionV1;
}>) {
    const statusLabel = readStatusLabel(props.payload.status);
    const summary = props.payload.summary?.trim() || null;
    const title = t('executionRuns.details.titles.executionRun');
    const runIdLabel = t('executionRuns.details.labels.runId', { value: props.payload.runId });

    return (
        <View
            testID={`execution-run-completion:${props.payload.runId}`}
            accessible
            accessibilityRole="text"
            accessibilityLabel={`${title}, ${statusLabel}. ${runIdLabel}${summary ? `. ${summary}` : ''}`}
            style={styles.container}
        >
            <View style={styles.headerRow}>
                <Text selectable style={styles.title}>{title}</Text>
                <View style={styles.statusPill}>
                    <Text selectable style={styles.statusText}>{statusLabel}</Text>
                </View>
            </View>
            <Text selectable style={styles.runId}>{props.payload.runId}</Text>
            {summary ? <Text selectable style={styles.summary}>{summary}</Text> : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.elevated,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        gap: 8,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    title: {
        color: theme.colors.text.primary,
        fontSize: 14,
        fontWeight: '600',
    },
    statusPill: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 999,
        backgroundColor: theme.colors.surface.inset,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    statusText: {
        color: theme.colors.text.secondary,
        fontSize: 11,
        fontWeight: '600',
    },
    runId: {
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
        fontSize: 12,
    },
    summary: {
        color: theme.colors.text.primary,
        fontSize: 13,
        lineHeight: 18,
    },
}));
