import {
  PromptStacksV1Schema,
  resolvePromptStackSystemAppendBlocksV1,
} from '@happier-dev/protocol';

import { fetchArtifactRecord, openArtifactDataEncryptionKey } from '@/api/artifacts/artifactRecords';
import { decodeBase64, decryptWithDataKey } from '@/api/encryption';
import type { Credentials } from '@/persistence';

export type PromptArtifactRecord = Readonly<{
  id: string;
  body?: string | null;
  dataEncryptionKey: string;
}>;

type FetchPromptArtifactRecord = (artifactId: string) => Promise<PromptArtifactRecord | null>;

// Prompt stacks degrade an unreadable artifact to a missing block; the session still starts.
async function fetchPromptArtifactRecordFromApi(params: Readonly<{
  credentials: Credentials;
  artifactId: string;
}>): Promise<PromptArtifactRecord | null> {
  const fetched = await fetchArtifactRecord(params);
  return fetched.ok ? fetched.record : null;
}

export async function resolveCliPromptStackSystemAppendBlocks(args: Readonly<{
  surface: 'coding' | 'voice';
  credentials: Credentials;
  settings: unknown;
  profileId?: string | null | undefined;
  cache?: Map<string, string | null>;
  fetchPromptArtifactRecord?: FetchPromptArtifactRecord;
}>): Promise<string[]> {
  const settings = args.settings && typeof args.settings === 'object' && !Array.isArray(args.settings)
    ? args.settings
    : {};
  const promptStacksV1 = PromptStacksV1Schema.parse((settings as { promptStacksV1?: unknown }).promptStacksV1);
  const cache = args.cache ?? new Map<string, string | null>();
  const fetchPromptArtifactRecord = args.fetchPromptArtifactRecord
    ? args.fetchPromptArtifactRecord
    : async (artifactId: string) => await fetchPromptArtifactRecordFromApi({
        credentials: args.credentials,
        artifactId,
      });

  return await resolvePromptStackSystemAppendBlocksV1({
    surface: args.surface,
    promptStacksV1,
    profileId: args.profileId ?? null,
    readArtifactBody: async (artifactId) => {
      if (cache.has(artifactId)) return cache.get(artifactId) ?? null;

      const artifact = await fetchPromptArtifactRecord(artifactId);
      if (!artifact?.body || !artifact.dataEncryptionKey) {
        cache.set(artifactId, null);
        return null;
      }

      const dataEncryptionKey = await openArtifactDataEncryptionKey({
        credentials: args.credentials,
        encryptedDataEncryptionKeyBase64: artifact.dataEncryptionKey,
      });
      if (!dataEncryptionKey) {
        cache.set(artifactId, null);
        return null;
      }

      const decrypted = decryptWithDataKey(decodeBase64(artifact.body), dataEncryptionKey) as { body?: unknown } | null;
      const body = typeof decrypted?.body === 'string' ? decrypted.body : null;
      cache.set(artifactId, body);
      return body;
    },
  });
}
