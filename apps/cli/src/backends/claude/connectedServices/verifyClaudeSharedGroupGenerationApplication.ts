import type { ConnectedServiceGenerationApplicationProofInput } from '@/daemon/connectedServices/credentials/lifecycleTypes';

import { readClaudeConnectedServiceHomeProvenance } from './claudeConnectedServiceHomeProvenance';
import { verifyClaudeCodeNativeAuth } from './nativeAuth/verifyClaudeCodeNativeAuth';
import { readClaudeGroupHomeSnapshot } from './readClaudeGroupHomeSnapshot';

type ClaudeSharedGroupGenerationApplicationProof =
  | Readonly<{ status: 'unavailable' }>
  | Readonly<{
    status: 'verified';
    source: 'claude_shared_group_home_provenance';
    sharedAuthSurfaceId: string;
    credentialRevision: NonNullable<ConnectedServiceGenerationApplicationProofInput['credentialRevision']>;
    credentialFingerprint: string;
  }>;

const UNAVAILABLE: ClaudeSharedGroupGenerationApplicationProof = { status: 'unavailable' };

export async function verifyClaudeSharedGroupGenerationApplication(
  input: ConnectedServiceGenerationApplicationProofInput,
): Promise<ClaudeSharedGroupGenerationApplicationProof> {
  if (input.serviceId !== 'claude-subscription') return UNAVAILABLE;
  const claudeConfigDir = input.environmentVariables.CLAUDE_CONFIG_DIR?.trim() ?? '';
  const credentialRevision = input.credentialRevision;
  if (!claudeConfigDir || credentialRevision === null) return UNAVAILABLE;
  // The provenance record and the credentials it certifies must come from ONE publication: read
  // unlocked, a concurrent rewrite to another member could pair this generation's record with the
  // next member's credentials (and then withdraw that record when its own publication fails).
  return await readClaudeGroupHomeSnapshot(claudeConfigDir, async () => {
    const provenance = await readClaudeConnectedServiceHomeProvenance(claudeConfigDir);
    if (
      provenance?.selection.kind !== 'group'
      || provenance.selection.groupId !== input.groupId
      || provenance.selection.activeProfileId !== input.profileId
      || provenance.credentialProfileId !== input.profileId
      || provenance.generation !== input.generation
      || provenance.credentialRevision !== credentialRevision
      || provenance.credentialFingerprint === undefined
      || (
        input.credentialFingerprint !== null
        && input.credentialFingerprint !== undefined
        && provenance.credentialFingerprint !== input.credentialFingerprint
      )
    ) {
      return UNAVAILABLE;
    }
    const nativeAuth = await verifyClaudeCodeNativeAuth({ claudeConfigDir });
    if (nativeAuth.status !== 'ok') return UNAVAILABLE;
    return {
      status: 'verified',
      source: 'claude_shared_group_home_provenance',
      sharedAuthSurfaceId: input.groupId,
      credentialRevision,
      credentialFingerprint: provenance.credentialFingerprint,
    };
  }, UNAVAILABLE);
}
