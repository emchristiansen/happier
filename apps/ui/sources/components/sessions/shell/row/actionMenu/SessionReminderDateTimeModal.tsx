import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { CustomModalInjectedProps } from '@/modal/types';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import {
    formatSessionReminderPresetRuleLabel,
    inferSessionReminderPresetRule,
    resolveSessionReminderPresetRule,
    type SessionReminderPresetV1,
} from '@/sync/domains/session/organization/sessionReminderPreset';
import { t } from '@/text';
import { isSessionReminderPickerAvailable, SessionReminderPicker } from './SessionReminderPicker';

export type SessionReminderDateTimeResult = Readonly<{
    remindAt: number;
    preset?: SessionReminderPresetV1;
}>;

function formatDateInput(date: Date): string {
    const year = String(date.getFullYear()).padStart(4, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatTimeInput(date: Date): string {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function parseLocalDateTime(dateValue: string, timeValue: string): number | null {
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue.trim());
    const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(timeValue.trim());
    if (!dateMatch || !timeMatch) return null;
    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);
    const value = new Date(year, month - 1, day, hour, minute, 0, 0);
    if (
        value.getFullYear() !== year
        || value.getMonth() !== month - 1
        || value.getDate() !== day
        || value.getHours() !== hour
        || value.getMinutes() !== minute
    ) return null;
    return value.getTime();
}

export function SessionReminderDateTimeModal(props: Readonly<{
    nowMs: number;
    onResolve: (value: SessionReminderDateTimeResult | null) => void;
}> & CustomModalInjectedProps) {
    const { theme } = useUnistyles();
    const initial = React.useMemo(() => new Date(resolveSessionReminderPresetRule({
        kind: 'relative_day',
        daysAhead: 1,
        minuteOfDay: 9 * 60,
    }, props.nowMs)), [props.nowMs]);
    const [dateValue, setDateValue] = React.useState(() => formatDateInput(initial));
    const [timeValue, setTimeValue] = React.useState(() => formatTimeInput(initial));
    const [savePreset, setSavePreset] = React.useState(false);
    const [pickerMode, setPickerMode] = React.useState<'date' | 'time' | null>(null);
    const dateAnchorRef = React.useRef<View | null>(null);
    const timeAnchorRef = React.useRef<View | null>(null);
    const parsed = parseLocalDateTime(dateValue, timeValue);
    const validTimestamp = parsed !== null && parsed > props.nowMs ? parsed : null;
    const rule = validTimestamp === null ? null : inferSessionReminderPresetRule(validTimestamp, props.nowMs);
    const pickerValue = React.useMemo(() => new Date(parsed ?? initial.getTime()), [initial, parsed]);
    const pickerAvailable = isSessionReminderPickerAvailable();

    const openPicker = React.useCallback((mode: 'date' | 'time') => {
        setPickerMode((current) => current === mode ? null : mode);
    }, []);

    const finish = React.useCallback((value: SessionReminderDateTimeResult | null) => {
        props.onResolve(value);
        props.onClose();
    }, [props]);

    const footer = React.useMemo(() => (
        <View style={{ paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', justifyContent: 'flex-end', gap: 10 }}>
            <RoundButton display="inverted" title={t('common.cancel')} onPress={() => finish(null)} />
            <RoundButton
                title={t('sessionsList.reminders.setReminder')}
                disabled={validTimestamp === null}
                onPress={() => {
                    if (validTimestamp === null) return;
                    finish({
                        remindAt: validTimestamp,
                        ...(savePreset && rule ? { preset: { rule } } : {}),
                    });
                }}
            />
        </View>
    ), [finish, rule, savePreset, validTimestamp]);

    useModalCardChrome(props.setChrome, React.useMemo(() => ({
        kind: 'card' as const,
        title: t('sessionsList.reminders.customTitle'),
        subtitle: t('sessionsList.reminders.customMessage'),
        testID: 'session-reminder-date-time-modal',
        dimensions: { width: 480, maxHeightRatio: 0.86, size: 'md' as const },
        footer,
    }), [footer]));

    const fieldStyle = {
        ...Typography.default(),
        color: theme.colors.text.primary,
        backgroundColor: theme.colors.input.background,
        borderColor: theme.colors.border.default,
        borderWidth: 1,
        borderRadius: 12,
        paddingLeft: 13,
        paddingRight: 48,
        paddingVertical: 11,
        fontSize: 16,
    };

    return (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 18, gap: 16 }}>
            <View style={{ flexDirection: 'row', gap: 12 }}>
                <View style={{ flex: 1, gap: 7 }}>
                    <Text style={{ color: theme.colors.text.secondary, fontSize: 13 }}>{t('sessionsList.reminders.dateLabel')}</Text>
                    <View ref={dateAnchorRef} style={{ position: 'relative' }}>
                        <TextInput testID="session-reminder-date-input" accessibilityLabel={t('sessionsList.reminders.dateLabel')} value={dateValue} onChangeText={setDateValue} placeholder={t('sessionsList.reminders.datePlaceholder')} style={fieldStyle} />
                        {pickerAvailable ? <Pressable testID="session-reminder-date-picker-button" accessibilityRole="button" accessibilityLabel={t('sessionsList.reminders.dateLabel')} hitSlop={8} onPress={() => openPicker('date')} style={({ pressed }) => ({ position: 'absolute', right: 4, top: 4, bottom: 4, width: 40, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.55 : 1 })}>
                            <Icon name="calendar" size={18} color={theme.colors.text.secondary} />
                        </Pressable> : null}
                    </View>
                </View>
                <View style={{ width: 132, gap: 7 }}>
                    <Text style={{ color: theme.colors.text.secondary, fontSize: 13 }}>{t('sessionsList.reminders.timeLabel')}</Text>
                    <View ref={timeAnchorRef} style={{ position: 'relative' }}>
                        <TextInput testID="session-reminder-time-input" accessibilityLabel={t('sessionsList.reminders.timeLabel')} value={timeValue} onChangeText={setTimeValue} placeholder="09:00" keyboardType="numbers-and-punctuation" style={fieldStyle} />
                        {pickerAvailable ? <Pressable testID="session-reminder-time-picker-button" accessibilityRole="button" accessibilityLabel={t('sessionsList.reminders.timeLabel')} hitSlop={8} onPress={() => openPicker('time')} style={({ pressed }) => ({ position: 'absolute', right: 4, top: 4, bottom: 4, width: 40, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.55 : 1 })}>
                            <Icon name="clock" size={18} color={theme.colors.text.secondary} />
                        </Pressable> : null}
                    </View>
                </View>
            </View>

            {pickerMode ? <SessionReminderPicker mode={pickerMode} anchorRef={pickerMode === 'date' ? dateAnchorRef : timeAnchorRef} value={pickerValue} minimumDate={new Date(props.nowMs)} accentColor={theme.colors.text.link} onDismiss={() => setPickerMode(null)} onChange={(value) => {
                if (pickerMode === 'date') setDateValue(formatDateInput(value));
                else setTimeValue(formatTimeInput(value));
            }} /> : null}

            <View style={{ borderRadius: 14, borderWidth: 1, borderColor: theme.colors.border.default, overflow: 'hidden' }}>
                <Item
                    title={t('sessionsList.reminders.addToPresets')}
                    subtitle={savePreset
                        ? (rule ? formatSessionReminderPresetRuleLabel(rule, props.nowMs) : t('sessionsList.reminders.presetPreviewUnavailable'))
                        : undefined}
                    rightElement={<Switch value={savePreset} onValueChange={setSavePreset} />}
                    showChevron={false}
                    showDivider={false}
                    onPress={() => setSavePreset((value) => !value)}
                />
            </View>
            {parsed !== null && parsed <= props.nowMs ? (
                <Text style={{ color: theme.colors.state.danger.foreground, fontSize: 13 }}>{t('sessionsList.reminders.futureTimeRequired')}</Text>
            ) : null}
        </ScrollView>
    );
}
