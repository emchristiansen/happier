import { buildProviderAccountUsageRecordId, type ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { computeProviderAccountUsageSnapshotFingerprint, computeProviderAccountUsageSnapshotMaterialRevision } from './fingerprint';

describe('provider account usage material fingerprint', () => {
  it('publishes presentation changes when the quota and recovery action data remain unchanged', () => {
    const recordKey = { providerId: 'codex', accountSubjectId: 'account', subjectKind: 'account', quotaScope: 'account' } as const;
    const snapshot: ProviderAccountUsageSnapshotV1 = {
      v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'codex',
      accountSubject: { kind: 'providerSubject', id: 'account' }, observedAtMs: 1_000, fetchedAtMs: 1_000,
      staleAfterMs: 300_000, source: 'runtimeSignal', confidence: 'confirmed', state: 'loaded_empty', meters: [],
      recoveryCreditDetails: { grant: { remainingCount: 2, appliesToProviderLimitIds: ['weekly'] } },
    };
    const key = new Uint8Array(32).fill(7);
    for (const grant of [
      { remainingCount: 1, appliesToProviderLimitIds: ['weekly'] },
      { remainingCount: 2, appliesToProviderLimitIds: ['weekly'], unavailableReason: 'cooldown' as const },
    ]) {
      const changed = { ...snapshot, recoveryCreditDetails: { grant } };
      expect(computeProviderAccountUsageSnapshotMaterialRevision(changed)).not.toBe(computeProviderAccountUsageSnapshotMaterialRevision(snapshot));
      expect(computeProviderAccountUsageSnapshotFingerprint(changed, key)).not.toBe(computeProviderAccountUsageSnapshotFingerprint(snapshot, key));
    }
  });
});
