import { createNoopProviderSettingsPlugin } from '@/agents/providers/shared/createNoopProviderSettingsPlugin';

export const FX_PROVIDER_SETTINGS_PLUGIN = createNoopProviderSettingsPlugin({
    providerId: 'fx',
    title: { key: 'settingsProviders.plugins.fx.title' },
    icon: { ionName: 'flash-outline', color: { kind: 'theme', token: 'purple' } },
});
