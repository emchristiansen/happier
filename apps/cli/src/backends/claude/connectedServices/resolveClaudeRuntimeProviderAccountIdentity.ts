import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { withConnectedServiceStateSharingDestinationLock } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingLock';

import { resolveConfiguredClaudeConfigDir } from '../utils/resolveConfiguredClaudeConfigDir';

import { readClaudeConnectedServiceHomeProvenance } from './claudeConnectedServiceHomeProvenance';
import { readClaudeOauthAccountIdentity, readClaudeRootConfigFile } from './claudeRootConfig';

export type ClaudeRuntimeProviderAccountIdentity = Readonly<{
  providerAccountId: string | null;
  providerEmail: string | null;
  providerOrganizationId: string | null;
}>;

/** The group selection tuple a caller will pair with the identity it reads. */
export type ClaudeRuntimeGroupSelectionTuple = Readonly<{
  groupId: string;
  activeProfileId: string;
  generation: number;
  credentialRevision?: string | null;
}>;

const UNPROVEN_IDENTITY: ClaudeRuntimeProviderAccountIdentity = {
  providerAccountId: null,
  providerEmail: null,
  providerOrganizationId: null,
};

// Bounded so a long-held writer lock delays a request dispatch only briefly; a timeout is unproven.
// The bound covers the whole snapshot, including any in-process queue ahead of the file lock's own
// acquire timeout (which only starts once this process's earlier waiters have finished).
const GROUP_HOME_SNAPSHOT_LOCK_TIMEOUT_MS = 2_000;

/**
 * Read the live provider-account identity from a materialized Claude config dir
 * (`<dir>/.claude.json` → `oauthAccount`). This is the SAME identity the runtime-auth adapter
 * consults when it forms exact-identity source links; keeping one owner avoids a second, drifting
 * identity source (mirrors Codex `readCodexAuthStoreProviderAccountId`).
 */
export async function readClaudeMaterializedOAuthAccountIdentity(
  claudeConfigDir: string,
): Promise<ClaudeRuntimeProviderAccountIdentity> {
  const rootConfig = await readClaudeRootConfigFile(join(claudeConfigDir, '.claude.json'));
  const identity = readClaudeOauthAccountIdentity(rootConfig?.oauthAccount);
  return {
    providerAccountId: identity.accountId,
    providerEmail: identity.email,
    providerOrganizationId: identity.providerOrganizationId,
  };
}

/**
 * A group home is shared by every runner of the group and rewritten by the daemon BEFORE those
 * runners are told of the new generation. Every maintained writer replaces credentials, the
 * `.claude.json` identity and the home's provenance record under the home's destination lock, so
 * the identity is attributable to the caller's tuple only when read in that same lock together
 * with a provenance record naming exactly that group, member, generation and credential revision.
 * Anything else — a moved, missing or unreadable record, or an unavailable lock — is unproven.
 */
async function readClaudeGroupHomeAccountIdentityForTuple(
  claudeConfigDir: string,
  tuple: ClaudeRuntimeGroupSelectionTuple,
): Promise<ClaudeRuntimeProviderAccountIdentity> {
  // Never create a home (or its lock) merely to read it.
  if (!await stat(claudeConfigDir).then((entry) => entry.isDirectory(), () => false)) return UNPROVEN_IDENTITY;
  let abandoned = false;
  const snapshot = withConnectedServiceStateSharingDestinationLock(claudeConfigDir, async () => {
    // Past the deadline the caller has already recorded unproven; do not read for nobody.
    if (abandoned) return UNPROVEN_IDENTITY;
    const provenance = await readClaudeConnectedServiceHomeProvenance(claudeConfigDir);
    const coherent = provenance?.selection.kind === 'group'
      && provenance.selection.groupId === tuple.groupId
      && provenance.credentialProfileId === tuple.activeProfileId
      && provenance.generation === tuple.generation
      && (provenance.credentialRevision ?? null) === (tuple.credentialRevision ?? null);
    return coherent ? await readClaudeMaterializedOAuthAccountIdentity(claudeConfigDir) : UNPROVEN_IDENTITY;
  }, { providerId: 'claude', acquireTimeoutMs: GROUP_HOME_SNAPSHOT_LOCK_TIMEOUT_MS });
  // A late outcome after the deadline is ignored, including a late failure.
  snapshot.catch(() => {});
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      snapshot,
      new Promise<ClaudeRuntimeProviderAccountIdentity>((resolve) => {
        deadline = setTimeout(() => {
          abandoned = true;
          resolve(UNPROVEN_IDENTITY);
        }, GROUP_HOME_SNAPSHOT_LOCK_TIMEOUT_MS);
        deadline.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Resolve the live provider-account identity for the CURRENT runtime, from the configured Claude
 * config dir (`CLAUDE_CONFIG_DIR` override or the default home). Fails closed — returns a null
 * `providerAccountId` when the account is genuinely unknown (e.g. api-key/anthropic sessions with
 * no `oauthAccount`), so unproven evidence never forms a source link.
 *
 * A caller that pairs the identity with a group selection tuple passes `groupSelection`; the
 * identity is then returned only from a coherent snapshot of that tuple (see above).
 */
export async function resolveClaudeRuntimeProviderAccountIdentity(
  params: Readonly<{ env: NodeJS.ProcessEnv; groupSelection?: ClaudeRuntimeGroupSelectionTuple | null }>,
): Promise<ClaudeRuntimeProviderAccountIdentity> {
  const claudeConfigDir = resolveConfiguredClaudeConfigDir({ env: params.env });
  return params.groupSelection
    ? await readClaudeGroupHomeAccountIdentityForTuple(claudeConfigDir, params.groupSelection)
    : await readClaudeMaterializedOAuthAccountIdentity(claudeConfigDir);
}
