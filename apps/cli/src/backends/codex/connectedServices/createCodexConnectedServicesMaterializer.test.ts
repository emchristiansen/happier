import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import { createConnectedServiceGroupMutationCurrentnessValidator } from '@/daemon/connectedServices/credentials/createConnectedServiceGroupMutationCurrentnessValidator';
import { resolveConnectedServiceSelectionHomeDir } from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';
import { createCodexConnectedServicesMaterializer } from './createCodexConnectedServicesMaterializer';
import { writeCodexAuthStoreFile } from './writeCodexAuthStoreFile';

describe('createCodexConnectedServicesMaterializer', () => {
  it('leaves current pool credentials untouched when the authoritative group target is unavailable', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-codex-group-currentness-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'stale-access', refreshToken: 'stale-refresh', idToken: 'id',
        providerAccountId: 'acct', providerEmail: null, scope: null, tokenType: null,
      },
    });
    const selection = {
      kind: 'group', serviceId: 'openai-codex', groupId: 'team', activeProfileId: 'work',
      fallbackProfileId: 'work', generation: 7, credentialRevision: null, record, policy: null,
    } as const;
    const rootDir = resolveConnectedServiceSelectionHomeDir({
      activeServerDir, serviceId: 'openai-codex', agentId: 'codex', fallbackProfileId: 'work', selection,
    });
    const codexHome = join(rootDir, 'codex-home');
    if (record.kind !== 'oauth') throw new Error('Expected OAuth fixture');
    await writeCodexAuthStoreFile({ codexHome, record: buildConnectedServiceCredentialRecord({
      ...record, now: 2_000, oauth: { ...record.oauth, raw: null, accessToken: 'current-access', refreshToken: 'current-refresh' },
    }) });
    const previousAuth = await readFile(join(codexHome, 'auth.json'), 'utf8');
    const previousProjection = await readFile(join(codexHome, '.happier-auth-projection.json'), 'utf8');

    // Only the remote API boundary is replaced; the canonical currentness reader remains real.
    const api = { getConnectedServiceAuthGroup: async () => null } as unknown as ApiClient;
    const result = await createCodexConnectedServicesMaterializer()({
      agentId: 'codex', activeServerDir, rootDir: join(activeServerDir, 'disposable-attempt'),
      recordsByServiceId: new Map([['openai-codex', record]]),
      selectionsByServiceId: new Map([['openai-codex', selection]]),
      sessionStateMode: 'existing', cleanupRoot: () => {},
      validateGroupMutationCurrentness: createConnectedServiceGroupMutationCurrentnessValidator({
        api, credentials: { token: 'fixture', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      }),
    });
    expect(await readFile(join(codexHome, 'auth.json'), 'utf8')).toBe(previousAuth);
    expect(await readFile(join(codexHome, '.happier-auth-projection.json'), 'utf8')).toBe(previousProjection);
    expect(result?.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'blocking', reason: 'authoritative_group_target_changed_before_materialization',
    }));
  });
});
