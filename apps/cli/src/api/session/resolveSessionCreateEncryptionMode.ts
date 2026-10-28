import axios from 'axios';

import {
  AccountEncryptionModeResponseSchema,
} from '@happier-dev/protocol';

import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { assertSessionEncryptionModeAllowedByEffectiveClientRequirement } from '@/settings/accountSettings/resolveEffectiveClientEncryptionRequirement';

export type DesiredSessionCreateEncryptionModeResult = Readonly<{
  desiredSessionEncryptionMode: 'e2ee' | 'plain';
  serverSupportsFeatureSnapshot: boolean;
  storagePolicy: 'required_e2ee' | 'optional' | 'plaintext_only';
}>;

export async function resolveSessionCreateEncryptionMode(params: Readonly<{
  token: string;
  serverBaseUrl: string;
  featuresTimeoutMs?: number;
  accountTimeoutMs?: number;
}>): Promise<DesiredSessionCreateEncryptionModeResult> {
  const featuresTimeoutMs = typeof params.featuresTimeoutMs === 'number' && params.featuresTimeoutMs > 0 ? params.featuresTimeoutMs : undefined;
  const accountTimeoutMs = typeof params.accountTimeoutMs === 'number' && params.accountTimeoutMs > 0 ? params.accountTimeoutMs : undefined;

  const featuresSnapshot = await fetchServerFeaturesSnapshot({
    serverUrl: params.serverBaseUrl,
    ...(featuresTimeoutMs ? { timeoutMs: featuresTimeoutMs } : {}),
  });
  if (featuresSnapshot.status === 'error') {
    throw Object.assign(
      new Error(`Unable to determine server session encryption policy: ${featuresSnapshot.reason}`),
      { retryable: true },
    );
  }
  const serverSupportsFeatureSnapshot = featuresSnapshot.status === 'ready';
  const storagePolicy: 'required_e2ee' | 'optional' | 'plaintext_only' =
    featuresSnapshot.status === 'ready'
      ? featuresSnapshot.features.capabilities.encryption.storagePolicy
      : 'required_e2ee';

  if (storagePolicy === 'plaintext_only') {
    assertSessionEncryptionModeAllowedByEffectiveClientRequirement('plain');
    return { desiredSessionEncryptionMode: 'plain', serverSupportsFeatureSnapshot, storagePolicy };
  }
  if (storagePolicy !== 'optional') {
    return { desiredSessionEncryptionMode: 'e2ee', serverSupportsFeatureSnapshot, storagePolicy };
  }

  // storagePolicy === 'optional': the account value is authoritative. Guessing
  // E2EE after a timeout can create a session that contradicts a plain-mode
  // account, so transport uncertainty must remain visible to the caller.
  const response = await axios.get(`${params.serverBaseUrl.replace(/\/+$/, '')}/v1/account/encryption`, {
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    ...(accountTimeoutMs ? { timeout: accountTimeoutMs } : {}),
    validateStatus: () => true,
  });
  if (response.status !== 200) {
    throw Object.assign(
      new Error(`Unable to read account encryption mode: HTTP ${response.status}`),
      { retryable: response.status >= 500 },
    );
  }
  const parsed = AccountEncryptionModeResponseSchema.safeParse(response.data);
  if (!parsed.success) {
    throw Object.assign(new Error('Unable to parse account encryption mode'), { retryable: false });
  }
  assertSessionEncryptionModeAllowedByEffectiveClientRequirement(parsed.data.mode);
  return {
    desiredSessionEncryptionMode: parsed.data.mode,
    serverSupportsFeatureSnapshot,
    storagePolicy,
  };
}
