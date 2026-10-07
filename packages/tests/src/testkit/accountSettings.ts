import { randomBytes } from 'node:crypto';

import {
  AccountSettingsV2UpdateResponseSchema,
  sealAccountScopedBlobCiphertext,
  type AccountSettingsV2UpdateResponse,
} from '@happier-dev/protocol';

import { fetchJson } from './http';

type AccountSettingsV2GetResponse = Readonly<{
  content?: Readonly<{ t: 'plain'; v: unknown }> | Readonly<{ t: 'encrypted'; c: string }> | null;
  version?: unknown;
}>;

async function tryWritePlainAccountSettingsV2(params: Readonly<{
  baseUrl: string;
  token: string;
  settings: unknown;
  expectedVersion: number;
}>): Promise<AccountSettingsV2UpdateResponse> {
  const postRes = await fetchJson<unknown>(`${params.baseUrl}/v2/account/settings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      expectedVersion: params.expectedVersion,
      content: { t: 'plain', v: params.settings },
    }),
    timeoutMs: 20_000,
  });

  if (postRes.status !== 200) {
    throw new Error(`Failed to update plain account settings (status=${postRes.status})`);
  }
  const parsed = AccountSettingsV2UpdateResponseSchema.safeParse(postRes.data);
  if (!parsed.success) {
    throw new Error('Failed to parse plain account settings update response');
  }
  return parsed.data;
}

async function writePlainAccountSettingsV2(params: Readonly<{
  baseUrl: string;
  token: string;
  settings: unknown;
  expectedVersion: number;
}>): Promise<number> {
  const result = await tryWritePlainAccountSettingsV2(params);
  if (!result.success) {
    throw new Error(
      `Failed to update plain account settings due to version mismatch (expected=${params.expectedVersion}, current=${result.currentVersion})`,
    );
  }
  return result.version;
}

export async function upsertPlainAccountSettingsV2(params: Readonly<{
  baseUrl: string;
  token: string;
  settings: unknown;
  expectedVersion?: number;
}>): Promise<number> {
  const getRes = await fetchJson<AccountSettingsV2GetResponse>(`${params.baseUrl}/v2/account/settings`, {
    headers: { Authorization: `Bearer ${params.token}` },
    timeoutMs: 20_000,
  });
  if (getRes.status !== 200 || typeof getRes.data?.version !== 'number') {
    throw new Error(`Failed to fetch current account settings version (status=${getRes.status})`);
  }
  if (getRes.data.content?.t === 'encrypted') {
    throw new Error('Cannot write plain account settings over encrypted account settings');
  }

  const expectedVersion = params.expectedVersion ?? getRes.data.version;
  return writePlainAccountSettingsV2({
    baseUrl: params.baseUrl,
    token: params.token,
    settings: params.settings,
    expectedVersion,
  });
}

export async function patchPlainAccountSettingsV2(params: Readonly<{
  baseUrl: string;
  token: string;
  settingsPatch: Readonly<Record<string, unknown>>;
}>): Promise<number> {
  const getRes = await fetchJson<AccountSettingsV2GetResponse>(`${params.baseUrl}/v2/account/settings`, {
    headers: { Authorization: `Bearer ${params.token}` },
    timeoutMs: 20_000,
  });
  if (getRes.status !== 200 || typeof getRes.data?.version !== 'number') {
    throw new Error(`Failed to fetch current account settings version (status=${getRes.status})`);
  }
  let currentContent = getRes.data.content ?? null;
  let currentVersion = getRes.data.version;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (currentContent?.t === 'encrypted') {
      throw new Error('Cannot patch plain account settings over encrypted account settings');
    }
    const currentSettings = currentContent?.t === 'plain'
      && typeof currentContent.v === 'object'
      && currentContent.v !== null
      && !Array.isArray(currentContent.v)
      ? currentContent.v as Record<string, unknown>
      : {};
    const result = await tryWritePlainAccountSettingsV2({
      baseUrl: params.baseUrl,
      token: params.token,
      expectedVersion: currentVersion,
      settings: {
        ...currentSettings,
        ...params.settingsPatch,
      },
    });
    if (result.success) return result.version;
    currentContent = result.currentContent;
    currentVersion = result.currentVersion;
  }

  throw new Error(`Failed to patch plain account settings after repeated version conflicts (current=${currentVersion})`);
}

export async function upsertEncryptedAccountSettingsV2(params: Readonly<{
  baseUrl: string;
  token: string;
  secret: Uint8Array;
  settings: unknown;
}>): Promise<void> {
  const getRes = await fetchJson<any>(`${params.baseUrl}/v2/account/settings`, {
    headers: { Authorization: `Bearer ${params.token}` },
    timeoutMs: 20_000,
  });
  if (getRes.status !== 200 || typeof getRes.data?.version !== 'number') {
    throw new Error(`Failed to fetch current account settings version (status=${getRes.status})`);
  }

  const postRes = await fetchJson<any>(`${params.baseUrl}/v2/account/settings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      expectedVersion: getRes.data.version,
      content: {
        t: 'encrypted',
        c: sealAccountScopedBlobCiphertext({
          kind: 'account_settings',
          material: { type: 'legacy', secret: params.secret },
          payload: params.settings,
          randomBytes: (length) => Uint8Array.from(randomBytes(length)),
        }),
      },
    }),
    timeoutMs: 20_000,
  });

  if (postRes.status !== 200 || postRes.data?.success !== true) {
    throw new Error(`Failed to update encrypted account settings (status=${postRes.status})`);
  }
}
