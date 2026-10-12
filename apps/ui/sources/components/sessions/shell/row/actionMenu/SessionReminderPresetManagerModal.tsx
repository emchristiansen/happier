import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { CustomModalInjectedProps } from '@/modal/types';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import {
    formatSessionReminderPresetRuleLabel,
    SESSION_REMINDER_PRESET_LABEL_MAX_LENGTH,
    sessionReminderPresetRuleKey,
    type SessionReminderPresetV1,
} from '@/sync/domains/session/organization/sessionReminderPreset';
import { t } from '@/text';

function moveItem(items: readonly SessionReminderPresetV1[], from: number, to: number): SessionReminderPresetV1[] {
    if (to < 0 || to >= items.length) return [...items];
    const next = [...items];
    const [item] = next.splice(from, 1);
    if (!item) return next;
    next.splice(to, 0, item);
    return next;
}

export function SessionReminderPresetManagerModal(props: Readonly<{
    presets: readonly SessionReminderPresetV1[];
    onResolve: (value: SessionReminderPresetV1[] | null) => void;
}> & CustomModalInjectedProps) {
    const { theme } = useUnistyles();
    const [drafts, setDrafts] = React.useState<SessionReminderPresetV1[]>(() => [...props.presets]);
    const finish = React.useCallback((value: SessionReminderPresetV1[] | null) => {
        props.onResolve(value);
        props.onClose();
    }, [props]);
    const footer = React.useMemo(() => (
        <View style={{ paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', justifyContent: 'flex-end', gap: 10 }}>
            <RoundButton display="inverted" title={t('common.cancel')} onPress={() => finish(null)} />
            <RoundButton title={t('common.save')} onPress={() => finish(drafts)} />
        </View>
    ), [drafts, finish]);

    useModalCardChrome(props.setChrome, React.useMemo(() => ({
        kind: 'card' as const,
        title: t('sessionsList.reminders.managePresets'),
        subtitle: t('sessionsList.reminders.managePresetsMessage'),
        testID: 'session-reminder-preset-manager-modal',
        layout: 'fill' as const,
        dimensions: { width: 560, maxHeightRatio: 0.86, size: 'md' as const },
        footer,
    }), [footer]));

    const updateLabel = React.useCallback((index: number, label: string) => {
        setDrafts((current) => current.map((preset, presetIndex) => presetIndex === index
            ? { rule: preset.rule, ...(label.trim().length > 0 ? { label } : {}) }
            : preset));
    }, []);

    return (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }} keyboardShouldPersistTaps="handled">
            {drafts.map((preset, index) => (
                <View
                    key={sessionReminderPresetRuleKey(preset.rule)}
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                        padding: 10,
                        borderRadius: 14,
                        borderWidth: 1,
                        borderColor: theme.colors.border.default,
                        backgroundColor: theme.colors.surface.base,
                    }}
                >
                    <View style={{ flex: 1, gap: 4 }}>
                        <TextInput
                            value={preset.label ?? ''}
                            placeholder={formatSessionReminderPresetRuleLabel(preset.rule)}
                            placeholderTextColor={theme.colors.text.secondary}
                            accessibilityLabel={t('sessionsList.reminders.presetName')}
                            maxLength={SESSION_REMINDER_PRESET_LABEL_MAX_LENGTH}
                            onChangeText={(value) => updateLabel(index, value)}
                            style={{ ...Typography.default('semiBold'), color: theme.colors.text.primary, paddingVertical: 5, paddingHorizontal: 7 }}
                        />
                        <Text style={{ color: theme.colors.text.secondary, fontSize: 12, paddingHorizontal: 7 }}>
                            {formatSessionReminderPresetRuleLabel(preset.rule)}
                        </Text>
                    </View>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('sessionsList.reminders.movePresetUp')}
                        disabled={index === 0}
                        onPress={() => setDrafts((current) => moveItem(current, index, index - 1))}
                        style={({ pressed }) => ({ padding: 9, opacity: index === 0 ? 0.28 : pressed ? 0.55 : 1 })}
                    >
                        <Icon name="arrow-up" size={16} color={theme.colors.text.secondary} />
                    </Pressable>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('sessionsList.reminders.movePresetDown')}
                        disabled={index === drafts.length - 1}
                        onPress={() => setDrafts((current) => moveItem(current, index, index + 1))}
                        style={({ pressed }) => ({ padding: 9, opacity: index === drafts.length - 1 ? 0.28 : pressed ? 0.55 : 1 })}
                    >
                        <Icon name="arrow-down" size={16} color={theme.colors.text.secondary} />
                    </Pressable>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('common.delete')}
                        onPress={() => setDrafts((current) => current.filter((_, presetIndex) => presetIndex !== index))}
                        style={({ pressed }) => ({ padding: 9, opacity: pressed ? 0.55 : 1 })}
                    >
                        <Icon name="trash" size={16} color={theme.colors.state.danger.foreground} />
                    </Pressable>
                </View>
            ))}
            {drafts.length === 0 ? (
                <View style={{ paddingVertical: 30, alignItems: 'center', gap: 7 }}>
                    <Text style={{ ...Typography.default('semiBold'), color: theme.colors.text.primary }}>{t('sessionsList.reminders.noPresets')}</Text>
                    <Text style={{ color: theme.colors.text.secondary, textAlign: 'center' }}>{t('sessionsList.reminders.noPresetsMessage')}</Text>
                </View>
            ) : null}
        </ScrollView>
    );
}
