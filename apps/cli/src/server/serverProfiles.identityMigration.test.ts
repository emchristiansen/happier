import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveBoxPublicKeyFromSeed } from '@happier-dev/protocol';
import { configuration, reloadConfiguration } from '@/configuration';
import { readCredentials, readSettings, updateSettings, writeCredentialsDataKey } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { addServerProfile, useServerProfile } from './serverProfiles';

const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature`;
const scope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL']);
afterEach(() => { scope.restore(); reloadConfiguration(); });

async function seed(home: string): Promise<string> {
  scope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: 'https://relay.example.test', HAPPIER_WEBAPP_URL: 'https://relay.example.test', HAPPIER_ACTIVE_SERVER_ID: undefined, HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_LOCAL_SERVER_URL: undefined });
  reloadConfiguration();
  const sourceId = configuration.activeServerId;
  const machineKey = new Uint8Array(32).fill(8);
  await writeCredentialsDataKey({ token, machineKey, publicKey: deriveBoxPublicKeyFromSeed(machineKey) });
  await updateSettings((s) => ({ ...s,
    machineIdByServerId: { [sourceId]: 'original-machine' },
    machineIdByServerIdByAccountId: { [sourceId]: { 'account-a': 'original-machine' } },
    lastTokenSubByServerId: { [sourceId]: 'account-a' },
    machineIdConfirmedByServerByServerId: { [sourceId]: true },
    lastChangesCursorByServerIdByAccountId: { [sourceId]: { 'account-a': 41 } },
    machineReplacementCandidatesByServerIdByAccountId: { [sourceId]: {} },
  }));
  scope.patch({ HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
  reloadConfiguration();
  return sourceId;
}

describe('derived profile credential and machine-state adoption', () => {
  it('carries the same credential source identity and account state into an empty named profile', async () => {
    await withTempDir('profile-identity-adoption-', async (home) => {
      const sourceId = await seed(home);
      const before = await readSettings();
      const target = await addServerProfile({ name: 'relay.example.test', serverUrl: 'https://relay.example.test', webappUrl: 'https://relay.example.test', use: true });
      reloadConfiguration();
      expect((await readCredentials())?.token).toBe(token);
      const after = await readSettings();
      expect(after.machineId).toBe('original-machine');
      for (const key of ['machineIdByServerId', 'machineIdByServerIdByAccountId', 'lastTokenSubByServerId', 'machineIdConfirmedByServerByServerId', 'lastChangesCursorByServerIdByAccountId', 'machineReplacementCandidatesByServerIdByAccountId'] as const) {
        expect(after[key]?.[sourceId]).toEqual(before[key]?.[sourceId]);
        expect(after[key]?.[target.id]).toEqual(before[key]?.[sourceId]);
      }
      const copiedKey = await readFile(join(home, 'servers', target.id, 'access.key'), 'utf8');
      await useServerProfile(target.id);
      expect(await readFile(join(home, 'servers', target.id, 'access.key'), 'utf8')).toBe(copiedKey);
      expect((await readSettings()).machineId).toBe('original-machine');
    });
  });

  it('keeps a destination machine and account history rather than mixing source state', async () => {
    await withTempDir('profile-identity-preserve-', async (home) => {
      const sourceId = await seed(home);
      await updateSettings((s) => ({ ...s,
        machineIdByServerId: { ...s.machineIdByServerId, target: 'target-machine' },
        machineIdByServerIdByAccountId: { ...s.machineIdByServerIdByAccountId, target: { 'account-b': 'target-machine' } },
        lastTokenSubByServerId: { ...s.lastTokenSubByServerId, target: 'account-b' },
      }));
      await addServerProfile({ name: 'target', serverUrl: 'https://relay.example.test', webappUrl: 'https://relay.example.test', use: true });
      reloadConfiguration();
      const after = await readSettings();
      expect(await readCredentials()).toBeNull();
      expect(after.machineIdByServerId?.target).toBe('target-machine');
      expect(after.machineIdByServerIdByAccountId?.target).toEqual({ 'account-b': 'target-machine' });
      expect(after.lastTokenSubByServerId?.target).toBe('account-b');
      expect(after.lastChangesCursorByServerIdByAccountId?.target).toBeUndefined();
      expect(after.machineIdByServerId?.[sourceId]).toBe('original-machine');
    });
  });
});
