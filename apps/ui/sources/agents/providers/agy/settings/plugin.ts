import { createNoopProviderSettingsPlugin } from '@/agents/providers/shared/createNoopProviderSettingsPlugin';

export const AGY_PROVIDER_SETTINGS_PLUGIN = createNoopProviderSettingsPlugin({
    providerId: 'agy',
    title: { key: 'settingsProviders.plugins.agy.title' },
    icon: { ionName: 'rocket-outline', color: '#111827' },
});
