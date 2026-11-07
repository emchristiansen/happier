import { KIMI_PROVIDER_FIELDS } from '@happier-dev/agents';

import type { ProviderSettingsPlugin } from '@/agents/providers/shared/providerSettingsPlugin';

export const KIMI_PROVIDER_SETTINGS_PLUGIN: ProviderSettingsPlugin = {
    providerId: 'kimi',
    title: { key: 'settingsProviders.plugins.kimi.title' },
    icon: { ionName: 'leaf-outline', color: { kind: 'theme', token: 'green' } },
    settings: KIMI_PROVIDER_FIELDS,
    uiSections: [],
    buildOutgoingMessageMetaExtras: () => ({}),
};
