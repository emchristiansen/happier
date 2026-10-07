import * as React from 'react';
import { Platform, TurboModuleRegistry, UIManager, View } from 'react-native';
import type { DateTimePickerEvent } from '@react-native-community/datetimepicker';

import type { SessionReminderPickerProps } from './SessionReminderPicker';

// UI 0.2.12 store binaries share this OTA runtime but do not contain this SDK.
// Probe before loading: Android 8.4.4 eagerly enforces its material modules too.
export function isSessionReminderPickerAvailable(): boolean {
    if (Platform.OS === 'ios') return UIManager.hasViewManagerConfig('RNDateTimePicker');
    if (Platform.OS === 'android') {
        return ['RNCDatePicker', 'RNCTimePicker', 'RNCMaterialDatePicker', 'RNCMaterialTimePicker']
            .every((name) => TurboModuleRegistry.get(name) !== null);
    }
    return false;
}

const DateTimePicker = React.lazy(() => import('@react-native-community/datetimepicker'));

export function SessionReminderPicker(props: SessionReminderPickerProps) {
    if (!isSessionReminderPickerAvailable()) return null;
    return <View testID={`session-reminder-${props.mode}-picker`} style={{ alignItems: 'center' }}>
        <React.Suspense fallback={null}>
            <DateTimePicker
                value={props.value}
                mode={props.mode}
                display={Platform.OS === 'ios' ? (props.mode === 'date' ? 'inline' : 'spinner') : (props.mode === 'date' ? 'calendar' : 'clock')}
                minimumDate={props.mode === 'date' ? props.minimumDate : undefined}
                accentColor={props.accentColor}
                onChange={(event: DateTimePickerEvent, value?: Date) => {
                    if (event.type === 'dismissed') { props.onDismiss(); return; }
                    if (value) props.onChange(value);
                    if (Platform.OS === 'android') props.onDismiss();
                }}
            />
        </React.Suspense>
    </View>;
}
