import { createNoopProviderSettingsPlugin } from '@/agents/providers/shared/createNoopProviderSettingsPlugin';

export const DROID_PROVIDER_SETTINGS_PLUGIN = createNoopProviderSettingsPlugin({
    providerId: 'droid',
    title: { key: 'settingsProviders.plugins.droid.title' },
    icon: { ionName: 'cpu', color: { kind: 'theme', token: 'blue' } },
});
