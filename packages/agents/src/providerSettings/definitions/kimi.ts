import { z } from 'zod';
import { buildSettingArtifacts, type SettingDefinitionMap } from '@happier-dev/protocol';

import type { ProviderSettingsDefinition } from '../types.js';

export const KIMI_PROVIDER_FIELDS = {} as const satisfies SettingDefinitionMap;

const KIMI_PROVIDER_ARTIFACTS = buildSettingArtifacts(KIMI_PROVIDER_FIELDS);

export const KIMI_PROVIDER_SETTINGS_DEFAULTS = Object.freeze(KIMI_PROVIDER_ARTIFACTS.defaults);

export function buildKimiProviderSettingsShape(_zod: typeof z) {
  return KIMI_PROVIDER_ARTIFACTS.shape;
}

export const KIMI_PROVIDER_SETTINGS_DEFINITION: ProviderSettingsDefinition = Object.freeze({
  providerId: 'kimi',
  fields: KIMI_PROVIDER_ARTIFACTS.definitions,
  buildOutgoingMessageMetaExtras: () => ({}),
  resolveSpawnExtras: () => ({}),
});
