import { describe, expect, it } from 'vitest';

import {
  diffConnectedServiceProjectionSnapshots,
  parseConnectedServiceProjectionSnapshot,
} from './connectedServiceProjectionSnapshot';

describe('parseConnectedServiceProjectionSnapshot', () => {
  it('keeps credential revision separate from group generation and exposes explicit credential boundaries', () => {
    const snapshot = parseConnectedServiceProjectionSnapshot({
      connectedServicesV2: [{
        serviceId: 'anthropic',
        profiles: [{ profileId: 'legacy', status: 'connected' }],
        groups: [
          { groupId: 'group-a', activeProfileId: 'profile-a', generation: 9, memberProfileIds: ['profile-a'] },
          { groupId: 'group-b', activeProfileId: 'profile-b', generation: 9, memberProfileIds: ['profile-b'] },
        ],
      }],
      connectedServiceCredentialRevisionsV1: [{
        serviceId: 'anthropic',
        profileId: 'profile-a',
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      }],
    });

    expect(snapshot.groups).toEqual([
      { serviceId: 'anthropic', groupId: 'group-a', activeProfileId: 'profile-a', generation: 9 },
      { serviceId: 'anthropic', groupId: 'group-b', activeProfileId: 'profile-b', generation: 9 },
    ]);
    expect(snapshot.resolveCredentialRevision('anthropic', 'profile-a')).toBe('csr_aaaaaaaaaaaaaaaaaaaaaa');
    expect(snapshot.resolveCredentialRevision('anthropic', 'profile-b')).toBeNull();
    expect(snapshot.resolveCredentialBoundary('anthropic', 'profile-a')).toEqual({
      status: 'present',
      revisionSemantics: 'revisioned',
      credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(snapshot.resolveCredentialBoundary('anthropic', 'profile-b')).toEqual({ status: 'absent' });
    expect(snapshot.resolveCredentialBoundary('anthropic', 'legacy')).toEqual({
      status: 'present',
      revisionSemantics: 'legacy_unfenced',
      credentialRevision: null,
    });
  });
});

describe('diffConnectedServiceProjectionSnapshots', () => {
  it('treats the first observed projection as a passive baseline and emits only later changed epochs', () => {
    const first = parseConnectedServiceProjectionSnapshot({
      connectedServicesV2: [{
        serviceId: 'anthropic',
        profiles: [],
        groups: [{ groupId: 'team', activeProfileId: 'primary', generation: 1, memberProfileIds: ['primary'] }],
      }],
      connectedServiceCredentialRevisionsV1: [{
        serviceId: 'anthropic',
        profileId: 'primary',
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      }],
    });
    const changed = parseConnectedServiceProjectionSnapshot({
      connectedServicesV2: [{
        serviceId: 'anthropic',
        profiles: [],
        groups: [{ groupId: 'team', activeProfileId: 'backup', generation: 2, memberProfileIds: ['backup'] }],
      }],
      connectedServiceCredentialRevisionsV1: [{
        serviceId: 'anthropic',
        profileId: 'backup',
        credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
      }],
    });

    expect(diffConnectedServiceProjectionSnapshots(null, first)).toEqual({
      changedGroupScopes: [],
      changedCredentialBoundaries: [],
      revokedGroupMembers: [],
    });
    expect(diffConnectedServiceProjectionSnapshots(first, first)).toEqual({
      changedGroupScopes: [],
      changedCredentialBoundaries: [],
      revokedGroupMembers: [],
    });
    expect(diffConnectedServiceProjectionSnapshots(first, changed)).toEqual({
      changedGroupScopes: [{ serviceId: 'anthropic', groupId: 'team' }],
      changedCredentialBoundaries: [{
        serviceId: 'anthropic',
        profileId: 'backup',
        boundary: {
          status: 'present',
          revisionSemantics: 'revisioned',
          credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
        },
      }, {
        serviceId: 'anthropic',
        profileId: 'primary',
        boundary: { status: 'absent' },
      }],
      revokedGroupMembers: [{ serviceId: 'anthropic', groupId: 'team', profileId: 'primary' }],
    });
  });

  it('diffs every member\'s enablement and credential, not only the active member', () => {
    const snapshot = (memberProfileIds: string[], revisions: Record<string, string>) => parseConnectedServiceProjectionSnapshot({
      connectedServicesV2: [{
        serviceId: 'anthropic',
        profiles: [],
        groups: [{ groupId: 'team', activeProfileId: 'primary', generation: 1, memberProfileIds }],
      }],
      connectedServiceCredentialRevisionsV1: Object.entries(revisions).map(([profileId, credentialRevision]) => ({
        serviceId: 'anthropic', profileId, credentialRevision,
      })),
    });
    const base = snapshot(['primary', 'backup'], { primary: 'csr_aaaaaaaaaaaaaaaaaaaaaa', backup: 'csr_bbbbbbbbbbbbbbbbbbbbbb' });
    expect(base.groupMemberships).toEqual([{ serviceId: 'anthropic', groupId: 'team', memberProfileIds: ['primary', 'backup'] }]);
    expect(base.isGroupMemberEligible('anthropic', 'team', 'backup')).toBe(true);
    expect(base.isGroupMemberEligible('anthropic', 'other', 'backup')).toBe(false);

    const disabled = snapshot(['primary'], { primary: 'csr_aaaaaaaaaaaaaaaaaaaaaa', backup: 'csr_bbbbbbbbbbbbbbbbbbbbbb' });
    expect(diffConnectedServiceProjectionSnapshots(base, disabled)).toEqual({
      changedGroupScopes: [],
      changedCredentialBoundaries: [],
      revokedGroupMembers: [{ serviceId: 'anthropic', groupId: 'team', profileId: 'backup' }],
    });

    const rotated = snapshot(['primary', 'backup'], { primary: 'csr_aaaaaaaaaaaaaaaaaaaaaa', backup: 'csr_cccccccccccccccccccccc' });
    expect(diffConnectedServiceProjectionSnapshots(base, rotated)).toEqual({
      changedGroupScopes: [],
      changedCredentialBoundaries: [{
        serviceId: 'anthropic',
        profileId: 'backup',
        boundary: { status: 'present', revisionSemantics: 'revisioned', credentialRevision: 'csr_cccccccccccccccccccccc' },
      }],
      revokedGroupMembers: [],
    });

    // Re-enabling is not a revocation.
    expect(diffConnectedServiceProjectionSnapshots(disabled, base).revokedGroupMembers).toEqual([]);
  });

  it('emits exact nullable direct-credential changes without including unchanged sibling scopes', () => {
    const previous = parseConnectedServiceProjectionSnapshot({
      connectedServicesV2: [],
      connectedServiceCredentialRevisionsV1: [
        { serviceId: 'openai-codex', profileId: 'deleted', credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa' },
        { serviceId: 'openai-codex', profileId: 'unchanged', credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' },
      ],
    });
    const current = parseConnectedServiceProjectionSnapshot({
      connectedServicesV2: [],
      connectedServiceCredentialRevisionsV1: [
        { serviceId: 'openai-codex', profileId: 'unchanged', credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' },
      ],
    });

    expect(diffConnectedServiceProjectionSnapshots(previous, current).changedCredentialBoundaries).toEqual([
      { serviceId: 'openai-codex', profileId: 'deleted', boundary: { status: 'absent' } },
    ]);
  });

  it('does not reinterpret a present legacy-unfenced profile with no revision as deletion', () => {
    const previous = parseConnectedServiceProjectionSnapshot({
      connectedServicesV2: [],
      connectedServiceCredentialRevisionsV1: [
        { serviceId: 'openai-codex', profileId: 'work', credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa' },
      ],
    });
    const current = parseConnectedServiceProjectionSnapshot({
      connectedServicesV2: [{
        serviceId: 'openai-codex',
        profiles: [{ profileId: 'work', status: 'connected' }],
        groups: [],
      }],
      connectedServiceCredentialRevisionsV1: [],
    });

    expect(diffConnectedServiceProjectionSnapshots(previous, current).changedCredentialBoundaries).toEqual([]);
  });

  it('represents a legacy-unfenced presence-to-absence delta without dereferencing a missing revision', () => {
    const previous = parseConnectedServiceProjectionSnapshot({
      connectedServicesV2: [{
        serviceId: 'openai-codex',
        profiles: [{ profileId: 'work', status: 'connected' }],
        groups: [],
      }],
      connectedServiceCredentialRevisionsV1: [],
    });
    const current = parseConnectedServiceProjectionSnapshot({
      connectedServicesV2: [],
      connectedServiceCredentialRevisionsV1: [],
    });

    expect(diffConnectedServiceProjectionSnapshots(previous, current).changedCredentialBoundaries).toEqual([
      {
        serviceId: 'openai-codex',
        profileId: 'work',
        boundary: { status: 'absent' },
      },
    ]);
  });
});
