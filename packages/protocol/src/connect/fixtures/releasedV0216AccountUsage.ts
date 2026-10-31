// Exact released snapshot/envelope readers from UI/server v0.2.16 and CLI v0.2.15,
// 22ac8263cfdbcdb845441b9044ff18199cf7652e, connect/accountUsage.ts.
// Only exported names/import locations change. Untouched validators and record-id
// algorithm are imported from the canonical owner; new display facts are absent here.
import { z } from 'zod';
import {
  buildProviderAccountUsageRecordId, ProviderAccountUsageRecordIdSchema,
  ProviderAccountUsageRecordKeyV1Schema, ProviderAccountSubjectRefV1Schema,
  ProviderAccountUsageSourceV1Schema, ProviderAccountUsageConfidenceV1Schema,
  ProviderAccountUsageStateV1Schema, ProviderAccountUsageDiagnosticV1Schema,
} from '../accountUsage.js';
import { ProviderAccountSubscriptionV1Schema, SealedProviderAccountSubscriptionV1Schema } from '../accountSubscription.js';
import {
  ConnectedServiceCredentialFormatSchema, ConnectedServiceQuotaRecoveryCreditsV1Schema,
  ConnectedServiceQuotaMeterV1Schema,
  ConnectedServiceUsageSourceV1Schema,
} from '../connectedServiceSchemas.js';
import { StoredJsonContentEnvelopeSchema } from '../../storage/storedJsonContentEnvelope.js';

export const ReleasedProviderAccountUsageSnapshotV1Schema = z.object({
  v: z.literal(1),
  recordId: ProviderAccountUsageRecordIdSchema,
  recordKey: ProviderAccountUsageRecordKeyV1Schema,
  providerId: z.string().trim().min(1).max(128),
  accountSubject: ProviderAccountSubjectRefV1Schema,
  observedAtMs: z.number().int().nonnegative(),
  fetchedAtMs: z.number().int().nonnegative(),
  staleAfterMs: z.number().int().min(1),
  source: ProviderAccountUsageSourceV1Schema,
  confidence: ProviderAccountUsageConfidenceV1Schema,
  state: ProviderAccountUsageStateV1Schema.default('loaded_data'),
  planLabel: z.string().trim().min(1).max(256).nullable().optional(),
  accountLabel: z.string().trim().min(1).max(256).nullable().optional(),
  recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1Schema.optional(),
  subscription: ProviderAccountSubscriptionV1Schema.optional(),
  meters: z.array(ConnectedServiceQuotaMeterV1Schema),
  diagnostics: z.array(ProviderAccountUsageDiagnosticV1Schema).optional(),
}).strict().superRefine((snapshot, ctx) => {
  if (snapshot.recordId !== buildProviderAccountUsageRecordId(snapshot.recordKey)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Snapshot recordId must match recordKey',
      path: ['recordId'],
    });
  }
  if (snapshot.providerId !== snapshot.recordKey.providerId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Snapshot providerId must match recordKey providerId',
      path: ['providerId'],
    });
  }
  if (snapshot.accountSubject.id !== snapshot.recordKey.accountSubjectId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Account subject id must match recordKey accountSubjectId',
      path: ['accountSubject', 'id'],
    });
  }
});

export const ReleasedSealedProviderAccountUsageSnapshotV1Schema = z.object({
  format: ConnectedServiceCredentialFormatSchema,
  ciphertext: z.string().min(1),
  subscription: SealedProviderAccountSubscriptionV1Schema.optional(),
});

// Exact body from the same released server, providerAccountUsageRoutesV3.ts POST.
export const ReleasedProviderAccountUsagePlainWriteSchema = z.object({
  content: StoredJsonContentEnvelopeSchema,
  metadata: z.object({
    fetchedAt: z.number().int().nonnegative(),
    staleAfterMs: z.number().int().min(1),
    status: z.enum(['ok', 'unavailable', 'estimated', 'error']),
    materialFingerprint: z.string().min(1).max(256).optional(),
    subscription: ProviderAccountSubscriptionV1Schema.optional(),
  }).strict(),
  source: ConnectedServiceUsageSourceV1Schema.optional(),
}).strict();
