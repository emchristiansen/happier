import * as React from 'react';
import { Platform } from 'react-native';
import { Stack } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { createAppStackScreenOptions } from '@/components/navigation/createAppStackScreenOptions';
import { getSettingsStackScreenDefinitions, type SettingsStackScope } from './settingsRouteRegistry';
import { t } from '@/text';
import { isRunningOnMac } from '@/utils/platform/platform';

export function SettingsStack({ scope = 'settings', screenLayout }: Readonly<{
    scope?: SettingsStackScope;
    screenLayout?: React.ComponentProps<typeof Stack>['screenLayout'];
}>) {
    const { theme } = useUnistyles();
    const shouldUseCustomHeader = Platform.OS === 'android' || isRunningOnMac() || Platform.OS === 'web';
    const screenOptions = React.useMemo(() => createAppStackScreenOptions({
        headerBackTitle: t('common.back'),
        shouldUseCustomHeader,
        theme,
    }), [shouldUseCustomHeader, theme]);
    const screenDefinitions = React.useMemo(() => getSettingsStackScreenDefinitions(t, scope), [scope]);

    return (
        <Stack screenOptions={screenOptions} screenLayout={screenLayout}>
            {screenDefinitions.map((definition) => (
                <Stack.Screen
                    key={definition.name}
                    name={definition.name}
                    options={definition.options}
                />
            ))}
        </Stack>
    );
}
