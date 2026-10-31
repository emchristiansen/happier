import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover/Popover';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { SessionReminderPickerProps } from './SessionReminderPicker';

export function isSessionReminderPickerAvailable(): boolean { return true; }

const DAY_SIZE = 38;
const MONDAY = new Date(2024, 0, 1, 12);

function dayOrdinal(value: Date): number {
    return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
}

function monthGrid(month: Date): Date[] {
    const first = new Date(month.getFullYear(), month.getMonth(), 1, 12);
    const startOffset = (first.getDay() + 6) % 7;
    return Array.from({ length: 42 }, (_, index) =>
        new Date(first.getFullYear(), first.getMonth(), 1 - startOffset + index, 12));
}

function withTimePart(value: Date, hour: number, minute: number): Date {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate(), hour, minute, 0, 0);
}

function PickerHeader(props: Readonly<{ title: string; onPrevious?: () => void; onNext?: () => void }>) {
    const { theme } = useUnistyles();
    return <View style={styles.header}>
        <Text style={[styles.headerTitle, { color: theme.colors.text.primary }]}>{props.title}</Text>
        {props.onPrevious && props.onNext ? <View style={styles.headerActions}>
            <Pressable accessibilityRole="button" accessibilityLabel={`${t('common.previous')}: ${props.title}`} hitSlop={8} onPress={props.onPrevious} style={({ pressed }) => [styles.iconButton, { backgroundColor: pressed ? theme.colors.surface.pressed : 'transparent' }]}>
                <Icon name="caret-left" size={16} color={theme.colors.text.secondary} />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={`${t('common.next')}: ${props.title}`} hitSlop={8} onPress={props.onNext} style={({ pressed }) => [styles.iconButton, { backgroundColor: pressed ? theme.colors.surface.pressed : 'transparent' }]}>
                <Icon name="caret-right" size={16} color={theme.colors.text.secondary} />
            </Pressable>
        </View> : null}
    </View>;
}

function CalendarPicker(props: SessionReminderPickerProps) {
    const { theme } = useUnistyles();
    const [visibleMonth, setVisibleMonth] = React.useState(() => new Date(props.value.getFullYear(), props.value.getMonth(), 1, 12));
    const days = React.useMemo(() => monthGrid(visibleMonth), [visibleMonth]);
    const weekdayLabels = React.useMemo(() => Array.from({ length: 7 }, (_, index) =>
        new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }).format(new Date(2024, 0, MONDAY.getDate() + index, 12))), []);
    const monthLabel = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(visibleMonth);
    const selectedOrdinal = dayOrdinal(props.value);
    const minimumOrdinal = dayOrdinal(props.minimumDate);
    const todayOrdinal = dayOrdinal(new Date());

    return <View testID="session-reminder-date-picker" style={styles.calendar}>
        <PickerHeader
            title={monthLabel}
            onPrevious={() => setVisibleMonth((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1, 12))}
            onNext={() => setVisibleMonth((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1, 12))}
        />
        <View style={styles.weekRow}>
            {weekdayLabels.map((label, index) => <Text key={`${label}-${index}`} style={[styles.weekday, { color: theme.colors.text.tertiary }]}>{label}</Text>)}
        </View>
        <View style={styles.dayGrid}>
            {days.map((day) => {
                const ordinal = dayOrdinal(day);
                const selected = ordinal === selectedOrdinal;
                const disabled = ordinal < minimumOrdinal;
                const outsideMonth = day.getMonth() !== visibleMonth.getMonth();
                return <Pressable
                    key={ordinal}
                    testID={`session-reminder-calendar-day-${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`}
                    accessibilityRole="button"
                    accessibilityLabel={new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(day)}
                    accessibilityState={{ selected, disabled }}
                    disabled={disabled}
                    onPress={() => {
                        props.onChange(withTimePart(day, props.value.getHours(), props.value.getMinutes()));
                        props.onDismiss();
                    }}
                    style={({ pressed }) => [
                        styles.day,
                        selected ? { backgroundColor: theme.colors.button.primary.background } : null,
                        ordinal === todayOrdinal && !selected ? { borderWidth: 1, borderColor: theme.colors.border.default } : null,
                        pressed && !selected ? { backgroundColor: theme.colors.surface.pressed } : null,
                    ]}
                >
                    <Text style={[
                        styles.dayText,
                        { color: selected ? theme.colors.button.primary.tint : theme.colors.text.primary },
                        outsideMonth ? { opacity: 0.38 } : null,
                        disabled ? { opacity: 0.22 } : null,
                    ]}>{day.getDate()}</Text>
                </Pressable>;
            })}
        </View>
    </View>;
}

function TimeColumn(props: Readonly<{ id: 'hh' | 'mm'; label: string; values: readonly number[]; selected: number; accentColor: string; onSelect: (value: number) => void }>) {
    const { theme } = useUnistyles();
    const scrollRef = React.useRef<React.ElementRef<typeof ScrollView> | null>(null);
    React.useEffect(() => {
        scrollRef.current?.scrollTo?.({ y: Math.max(0, props.selected * 38 - 88), animated: false });
    }, [props.selected]);
    return <View style={styles.timeColumn}>
        <Text style={[styles.timeColumnLabel, { color: theme.colors.text.tertiary }]}>{props.label}</Text>
        <ScrollView ref={scrollRef} style={styles.timeScroll} contentContainerStyle={styles.timeScrollContent} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {props.values.map((value) => {
                const selected = value === props.selected;
                return <Pressable
                    key={value}
                    testID={`session-reminder-time-${props.id}-${value}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => props.onSelect(value)}
                    style={({ pressed }) => [styles.timeOption, selected ? { backgroundColor: theme.colors.surface.elevated } : null, pressed ? { opacity: 0.66 } : null]}
                >
                    <Text style={[styles.timeOptionText, { color: selected ? theme.colors.text.primary : theme.colors.text.secondary }]}>{String(value).padStart(2, '0')}</Text>
                    {selected ? <View style={[styles.selectionDot, { backgroundColor: props.accentColor }]} /> : null}
                </Pressable>;
            })}
        </ScrollView>
    </View>;
}

function TimePicker(props: SessionReminderPickerProps) {
    const selectedHour = props.value.getHours();
    const selectedMinute = props.value.getMinutes();
    return <View testID="session-reminder-time-picker" style={styles.timePicker}>
        <PickerHeader title={new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(props.value)} />
        <View style={styles.timeColumns}>
            <TimeColumn id="hh" label={t('sessionsList.reminders.hourLabel')} values={Array.from({ length: 24 }, (_, value) => value)} selected={selectedHour} accentColor={props.accentColor} onSelect={(hour) => props.onChange(withTimePart(props.value, hour, selectedMinute))} />
            <TimeColumn id="mm" label={t('sessionsList.reminders.minuteLabel')} values={Array.from({ length: 60 }, (_, value) => value)} selected={selectedMinute} accentColor={props.accentColor} onSelect={(minute) => props.onChange(withTimePart(props.value, selectedHour, minute))} />
        </View>
        <View style={styles.timeFooter}><RoundButton size="small" title={t('common.done')} onPress={props.onDismiss} /></View>
    </View>;
}

export function SessionReminderPicker(props: SessionReminderPickerProps) {
    return <Popover
        open={true}
        anchorRef={props.anchorRef}
        placement="bottom"
        gap={8}
        maxWidthCap={360}
        maxHeightCap={390}
        edgePadding={{ horizontal: 12, vertical: 12 }}
        portal={{ web: true, matchAnchorWidth: false, anchorAlign: props.mode === 'date' ? 'start' : 'end' }}
        onRequestClose={props.onDismiss}
        backdrop={{ enabled: true, blockOutsidePointerEvents: false }}
    >
        {({ maxHeight }) => <FloatingOverlay
            maxHeight={maxHeight}
            scrollEnabled={false}
            surfaceChrome="theme"
            containerStyle={{ width: props.mode === 'date' ? 320 : 280 }}
        >
            {props.mode === 'date' ? <CalendarPicker {...props} /> : <TimePicker {...props} />}
        </FloatingOverlay>}
    </Popover>;
}

const styles = StyleSheet.create(() => ({
    calendar: { padding: 12 },
    header: { minHeight: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4, marginBottom: 6 },
    headerTitle: { ...Typography.default('semiBold'), fontSize: 15, fontWeight: '600' },
    headerActions: { flexDirection: 'row', gap: 2 },
    iconButton: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
    weekRow: { width: DAY_SIZE * 7, alignSelf: 'center', flexDirection: 'row', marginBottom: 4 },
    weekday: { width: DAY_SIZE, textAlign: 'center', fontSize: 11, fontWeight: '600' },
    dayGrid: { width: DAY_SIZE * 7, alignSelf: 'center', flexDirection: 'row', flexWrap: 'wrap' },
    day: { width: DAY_SIZE, height: DAY_SIZE, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
    dayText: { ...Typography.default(), fontSize: 13, fontVariant: ['tabular-nums'] },
    timePicker: { padding: 12 },
    timeColumns: { height: 230, flexDirection: 'row', gap: 8 },
    timeColumn: { flex: 1, minWidth: 0 },
    timeColumnLabel: { paddingHorizontal: 10, paddingBottom: 6, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
    timeScroll: { flex: 1 },
    timeScrollContent: { gap: 2, paddingBottom: 8 },
    timeOption: { height: 36, borderRadius: 10, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    timeOptionText: { ...Typography.default(), fontSize: 14, fontVariant: ['tabular-nums'] },
    selectionDot: { width: 5, height: 5, borderRadius: 3 },
    timeFooter: { alignItems: 'flex-end', paddingTop: 10 },
}));
