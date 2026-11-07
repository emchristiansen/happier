import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import { requireConnectedServiceOauthCredentialRecord } from '@/daemon/connectedServices/shared/connectedServiceCredentialRecord';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { withConnectedServiceStateSharingLocks } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingLock';
import type { ConnectedServiceSharedGenerationMutationCurrentness } from '@/daemon/connectedServices/credentials/lifecycleTypes';

async function readProjectionJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sourceProjection(record: ConnectedServiceCredentialRecordV1) {
  const credential = requireConnectedServiceOauthCredentialRecord(record);
  const tokens = {
    access_token: credential.oauth.accessToken,
    refresh_token: credential.oauth.refreshToken,
    id_token: credential.oauth.idToken,
    account_id: credential.oauth.providerAccountId,
  } as const;
  return { tokens, fingerprint: createHash('sha256').update(JSON.stringify(tokens)).digest('hex') };
}

async function matchesSourceProjection(codexHome: string, source: ReturnType<typeof sourceProjection>): Promise<boolean> {
  const projection = asRecord(await readProjectionJson(join(codexHome, '.happier-auth-projection.json')));
  const existing = asRecord(await readProjectionJson(join(codexHome, 'auth.json')));
  const tokens = asRecord(existing?.tokens);
  return projection?.fingerprint === source.fingerprint
    && existing?.auth_mode === 'chatgpt'
    && typeof existing.last_refresh === 'string' && Number.isFinite(Date.parse(existing.last_refresh))
    && tokens?.account_id === source.tokens.account_id
    && typeof tokens.access_token === 'string' && tokens.access_token.length > 0
    && typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0;
}

/** Prove daemon preparation without rewriting tokens that native disk-auth clients rotated. */
export async function isCodexAuthStoreProjectionCurrent(params: Readonly<{
  codexHome: string;
  record: ConnectedServiceCredentialRecordV1;
}>): Promise<boolean> {
  const source = sourceProjection(params.record);
  return await withConnectedServiceStateSharingLocks([params.codexHome],
    async () => await matchesSourceProjection(params.codexHome, source), { providerId: 'codex' });
}

/**
 * Canonical writer for the Codex auth store (`<codexHome>/auth.json`).
 *
 * Disk-auth launches consume this projection. External-token app-server auth is process-local;
 * selection materialization persists the selected binding here for later launches, not reconnects.
 */
export async function writeCodexAuthStoreFile(params: Readonly<{
  codexHome: string;
  record: ConnectedServiceCredentialRecordV1;
  validateCurrentBeforeMutation?: () => Promise<ConnectedServiceSharedGenerationMutationCurrentness>;
}>): Promise<boolean> {
  const { tokens, fingerprint } = sourceProjection(params.record);
  const projectionPath = join(params.codexHome, '.happier-auth-projection.json');
  return await withConnectedServiceStateSharingLocks([params.codexHome], async () => {
    if (params.validateCurrentBeforeMutation && !(await params.validateCurrentBeforeMutation()).current) return false;
    // Compare the last Happier source, not the mutable native file: native disk-auth clients can
    // rotate it independently. Unchanged source must not roll a newer native refresh token back.
    if (await matchesSourceProjection(params.codexHome, { tokens, fingerprint })) return true;
    await writeJsonAtomic(join(params.codexHome, 'auth.json'), {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      ...tokens,
      // Match Codex CLI expectations while keeping our existing flat format for backward compatibility.
      tokens,
      last_refresh: new Date().toISOString(),
    });
    await writeJsonAtomic(projectionPath, { v: 1, fingerprint });
    return true;
  }, { providerId: 'codex' });
}
