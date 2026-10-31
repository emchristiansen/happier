import { describe, expect, it } from 'vitest';

import { AccountProfileSchema as ReleasedAccountProfileSchema } from './fixtures/releasedV0215AccountProfile.js';
import { SessionRuntimeIssueV1Schema as ReleasedRuntimeIssueSchema } from './fixtures/releasedV0215RuntimeIssue.js';
import { SessionRuntimeIssueV1Schema } from '../sessions/control/runtimeIssueV1.js';
import { AccountProfileSchema } from '../account/profile.js';
import { ConnectedServiceIdSchema } from './connectedServiceBindings.js';
import { FeaturesResponseSchema } from '../features.js';
import {
  readConnectedServiceReaderSupport,
  projectConnectedServiceProfileForReader,
  projectSessionRuntimeIssueForReader,
  supportsConnectedServiceOperation,
  withConnectedServiceReaderSupport,
} from './connectedServiceReaderSupport.js';

describe('released connected-service readers', () => {
  it('preserves known profiles and revisions together while unsupported services remain authoritative', () => {
    const profile = AccountProfileSchema.parse({
      id: 'account',
      connectedServicesV2: ['openai-codex', 'antigravity'].map(serviceId => ({ serviceId, profiles: [{ profileId: 'work', status: 'connected' }], groups: [] })),
      connectedServiceCredentialRevisionsV1: ['openai-codex', 'antigravity'].map(serviceId => ({ serviceId, profileId: 'work', credentialRevision: 'csr_abcdefghijklmnopqrstuv' })),
    });
    expect(ReleasedAccountProfileSchema.safeParse(profile).success).toBe(false);
    const projected = projectConnectedServiceProfileForReader(profile, readConnectedServiceReaderSupport(undefined));
    expect(ReleasedAccountProfileSchema.safeParse(projected).success).toBe(true);
    expect(projected.connectedServicesV2.map(entry => entry.serviceId)).toEqual(['openai-codex']);
    expect(projected.connectedServiceCredentialRevisionsV1.map(entry => entry.serviceId)).toEqual(['openai-codex']);
    expect(profile.connectedServicesV2).toHaveLength(2);
    expect(projectConnectedServiceProfileForReader(profile, readConnectedServiceReaderSupport(ConnectedServiceIdSchema.options))).toEqual(profile);
  });

  it('retains failed status, provider and retry/reset facts but removes each unsupported optional reference', () => {
    const issue = SessionRuntimeIssueV1Schema.parse({
      v: 1, scope: 'primary_session', status: 'failed', source: 'usage_limit', code: 'usage_limit', occurredAt: 12, provider: 'agy',
      usageLimit: { v: 1, resetAtMs: 500, retryAfterMs: 200, quotaScope: 'account', recoverability: 'switch_account',
        connectedService: { serviceId: 'antigravity', profileId: 'work', groupId: null },
        quotaSnapshotRef: { serviceId: 'antigravity', profileId: 'work', fetchedAtMs: 10 },
      },
    });
    expect(ReleasedRuntimeIssueSchema.safeParse(issue).success).toBe(false);
    const projected = projectSessionRuntimeIssueForReader(issue, readConnectedServiceReaderSupport('invalid'));
    expect(ReleasedRuntimeIssueSchema.safeParse(projected).success).toBe(true);
    expect(projected).toMatchObject({ status: 'failed', provider: 'agy', usageLimit: { resetAtMs: 500, retryAfterMs: 200, recoverability: 'switch_account' } });
    expect(projected.usageLimit).not.toHaveProperty('connectedService');
    expect(projected.usageLimit).not.toHaveProperty('quotaSnapshotRef');
    expect(issue.usageLimit?.connectedService?.serviceId).toBe('antigravity');
    expect(projectSessionRuntimeIssueForReader(issue, readConnectedServiceReaderSupport(ConnectedServiceIdSchema.options))).toEqual(issue);
    const mixedIssue = SessionRuntimeIssueV1Schema.parse({ ...issue, usageLimit: { ...issue.usageLimit, quotaSnapshotRef: { serviceId: 'openai-codex', profileId: 'work' } } });
    const mixedProjection = projectSessionRuntimeIssueForReader(mixedIssue, readConnectedServiceReaderSupport(undefined));
    expect(mixedProjection.usageLimit).not.toHaveProperty('connectedService');
    expect(mixedProjection.usageLimit?.quotaSnapshotRef).toEqual(mixedIssue.usageLimit?.quotaSnapshotRef);
  });

  it('negotiates only declared recognized services and leaves older server operations available', () => {
    expect(readConnectedServiceReaderSupport(undefined)).not.toContain('antigravity');
    expect(readConnectedServiceReaderSupport('["antigravity"]')).toContain('antigravity');
    expect(readConnectedServiceReaderSupport('["antigravity",42]')).not.toContain('antigravity');
    expect(supportsConnectedServiceOperation({}, 'antigravity')).toBe(false);
    expect(supportsConnectedServiceOperation({ capabilities: { connectedServices: { supportedServiceIds: '["antigravity"]' } } }, 'antigravity')).toBe(false);
    expect(supportsConnectedServiceOperation({ capabilities: { connectedServices: { supportedServiceIds: ['antigravity', 42] } } }, 'antigravity')).toBe(false);
    expect(supportsConnectedServiceOperation({}, 'openai-codex')).toBe(true);
    const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { connectedServices: { supportedServiceIds: ConnectedServiceIdSchema.options } } });
    expect(supportsConnectedServiceOperation(features, 'antigravity')).toBe(true);
    const url = new URL(withConnectedServiceReaderSupport('/v1/sessions?limit=3#fragment'), 'https://server.test');
    expect(url.searchParams.get('limit')).toBe('3');
    expect(readConnectedServiceReaderSupport(url.searchParams.get('happierConnectedServices'))).toContain('antigravity');
    expect(url.hash).toBe('#fragment');
    const twice = new URL(withConnectedServiceReaderSupport(withConnectedServiceReaderSupport('/v1/sessions?limit=3')), 'https://server.test');
    expect(twice.searchParams.getAll('happierConnectedServices')).toHaveLength(1);
  });
});
