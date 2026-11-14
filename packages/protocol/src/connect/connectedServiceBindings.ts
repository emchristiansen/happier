import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

export const ConnectedServiceIdSchema = lazySchema(() => z.enum([
    'openai-codex',
    'openai',
    'anthropic',
    'claude-subscription',
    'gemini',
    'antigravity',
    'github',
]));

export type ConnectedServiceId = z.infer<typeof ConnectedServiceIdSchema>;

export const ConnectedServiceProfileIdSchema = lazySchema(() => z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,63}$/, 'Invalid profile id'));

export type ConnectedServiceProfileId = z.infer<typeof ConnectedServiceProfileIdSchema>;

export const ConnectedServiceAuthGroupIdSchema = lazySchema(() => z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/, 'Invalid connected service account group id'));

export type ConnectedServiceAuthGroupId = z.infer<typeof ConnectedServiceAuthGroupIdSchema>;

const ConnectedServiceNativeBindingV1Schema = lazySchema(() => z
    .object({
        source: z.literal('native'),
    })
    .passthrough());

const ConnectedServiceProfileBindingV1Schema = lazySchema(() => z
    .object({
        source: z.literal('connected'),
        selection: z.literal('profile').optional().default('profile'),
        profileId: ConnectedServiceProfileIdSchema,
    })
    .passthrough());

export const ConnectedServiceGroupMemberAssignmentReasonV1Schema = lazySchema(() => z.enum([
    'initial_requested',
    'initial_sampled',
    'initial_unavailable_failover',
    'failover',
    'member_revoked',
    'policy_conversion',
]));

export type ConnectedServiceGroupMemberAssignmentReasonV1 = z.infer<typeof ConnectedServiceGroupMemberAssignmentReasonV1Schema>;

/** The session's own applied member under a per_session_softmax group (spec A.1). */
export const ConnectedServiceGroupMemberAssignmentV1Schema = lazySchema(() => z
    .object({
        assignment: z.literal('per_session'),
        profileId: ConnectedServiceProfileIdSchema,
        decisionId: z.string().min(1).max(200),
        reason: ConnectedServiceGroupMemberAssignmentReasonV1Schema,
        fromProfileId: ConnectedServiceProfileIdSchema.optional(),
        appliedAtMs: z.number().int().nonnegative(),
        temperature: z.number().finite().positive().optional(),
        offsetPercent: z.number().finite().positive().optional(),
        probability: z.number().finite().min(0).max(1).optional(),
    })
    .strict());

export type ConnectedServiceGroupMemberAssignmentV1 = z.infer<typeof ConnectedServiceGroupMemberAssignmentV1Schema>;

/**
 * Internal PENDING per-session target: the member a session was materialized onto (spawn or
 * restart) before provider-observed adoption proves it. Promoted to `member` on adoption.
 */
export const ConnectedServiceGroupMaterializedAssignmentV1Schema = lazySchema(() => z
    .object({
        profileId: ConnectedServiceProfileIdSchema,
        decisionId: z.string().min(1).max(200),
        reason: ConnectedServiceGroupMemberAssignmentReasonV1Schema,
        fromProfileId: ConnectedServiceProfileIdSchema.optional(),
        materializedAtMs: z.number().int().nonnegative(),
        /**
         * Conversion target (spec A.4 Migration): materialize the group's shared home instead of the
         * member home; on adoption the session's per-session ownership is removed rather than promoted.
         */
        home: z.literal('group').optional(),
        temperature: z.number().finite().positive().optional(),
        offsetPercent: z.number().finite().positive().optional(),
        probability: z.number().finite().min(0).max(1).optional(),
    })
    .strict());

export type ConnectedServiceGroupMaterializedAssignmentV1 = z.infer<typeof ConnectedServiceGroupMaterializedAssignmentV1Schema>;

/** Internal-only assignment state that callers may never supply. */
export const CONNECTED_SERVICE_INTERNAL_ASSIGNMENT_FIELDS = Object.freeze([
    'member',
    'materializedAssignment',
    'pendingAssignment',
    'decisionId',
] as const);

export const CONNECTED_SERVICE_INTERNAL_ASSIGNMENT_FIELD_FORBIDDEN_ERROR = 'connected_service_internal_assignment_field_forbidden';
export const CONNECTED_SERVICE_INITIAL_PROFILE_REQUIRES_GROUP_ERROR = 'connected_service_initial_profile_requires_group';

/**
 * Returns the `<serviceId>.<field>` paths of internal assignment fields present in external input.
 * Accepts either a V1 envelope or a bare bindingsByServiceId record; unknown shapes yield [].
 */
export function findConnectedServiceInternalAssignmentFields(input: unknown): string[] {
    if (!input || typeof input !== 'object') return [];
    const record = input as Record<string, unknown>;
    const byServiceId = record.bindingsByServiceId && typeof record.bindingsByServiceId === 'object'
        ? record.bindingsByServiceId as Record<string, unknown>
        : record;
    const found: string[] = [];
    for (const [serviceId, binding] of Object.entries(byServiceId)) {
        if (!binding || typeof binding !== 'object') continue;
        for (const field of CONNECTED_SERVICE_INTERNAL_ASSIGNMENT_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(binding, field)) found.push(`${serviceId}.${field}`);
        }
    }
    return found;
}

const ConnectedServiceGroupBindingV1Schema = lazySchema(() => z
    .object({
        source: z.literal('connected'),
        selection: z.literal('group'),
        groupId: ConnectedServiceAuthGroupIdSchema,
        profileId: ConnectedServiceProfileIdSchema.optional(),
        // Runtime account evidence; profileId remains the requested fallback.
        appliedProfileId: ConnectedServiceProfileIdSchema.optional(),
        // External request to start on this member (per_session_softmax groups). Not adoption evidence.
        initialProfileId: ConnectedServiceProfileIdSchema.optional(),
        // Internal APPLIED per-session assignment. Rejected at every external entry point; see
        // findConnectedServiceInternalAssignmentFields.
        member: ConnectedServiceGroupMemberAssignmentV1Schema.optional(),
        materializedAssignment: ConnectedServiceGroupMaterializedAssignmentV1Schema.optional(),
    })
    .passthrough());

export const ConnectedServiceBindingSelectionV1Schema = lazySchema(() => z.union([
    ConnectedServiceNativeBindingV1Schema,
    ConnectedServiceGroupBindingV1Schema,
    ConnectedServiceProfileBindingV1Schema,
]));

export type ConnectedServiceBindingSelectionV1 = z.infer<typeof ConnectedServiceBindingSelectionV1Schema>;

const ConnectedServiceBindingsByServiceIdV1Schema = lazySchema(() => z
    .record(z.string(), ConnectedServiceBindingSelectionV1Schema)
    .superRefine((bindings, ctx) => {
        for (const serviceId of Object.keys(bindings)) {
            if (!ConnectedServiceIdSchema.safeParse(serviceId).success) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'Invalid connected service id',
                    path: [serviceId],
                });
            }
        }
    }));

export const ConnectedServiceBindingsV1Schema = lazySchema(() => z
    .object({
        v: z.literal(1),
        bindingsByServiceId: ConnectedServiceBindingsByServiceIdV1Schema.default({}),
    })
    .strict());

export type ConnectedServiceBindingsV1 = z.infer<typeof ConnectedServiceBindingsV1Schema>;

export const SessionConnectedServiceAuthSwitchRpcParamsSchema = lazySchema(() => z
    .object({
        sessionId: z.string().trim().min(1),
        agentId: z.string().trim().min(1),
        bindings: ConnectedServiceBindingsV1Schema,
        rematerializeServiceId: ConnectedServiceIdSchema.optional(),
        expectedGroupGenerationByServiceId: z.record(z.string(), z.number().int().nonnegative()).optional(),
        accountSettingsVersionHint: z.number().int().nonnegative().optional(),
        quotaRecovery: z.object({
            requestId: z.string().min(1),
            nativeId: z.string().min(1),
            pid: z.number().int().positive(),
            processInstanceFingerprint: z.string().min(1),
            serviceId: z.enum(['openai-codex', 'claude-subscription']),
            profileId: ConnectedServiceProfileIdSchema,
            failureAttemptId: z.string().min(1),
            failureArmedAtMs: z.number().int().nonnegative(),
            nativePublisherIncarnationId: z.string().min(1),
            nativeObservationSequence: z.string().regex(/^(0|[1-9][0-9]*)$/),
            failureObservedAtMs: z.number().int().nonnegative(),
        }).strict().optional(),
    })
    .strict()
    .superRefine((request, context) => {
        if (request.quotaRecovery && (
            request.rematerializeServiceId !== undefined
            || request.accountSettingsVersionHint !== undefined
            || request.expectedGroupGenerationByServiceId !== undefined
        )) {
            context.addIssue({ code: z.ZodIssueCode.custom,
                message: 'Quota recovery permits only its guarded account selection', path: ['quotaRecovery'] });
        }
    }));

export type SessionConnectedServiceAuthSwitchRpcParams = z.infer<
    typeof SessionConnectedServiceAuthSwitchRpcParamsSchema
>;

function omitConnectedServiceBindingFields<T>(input: T, fields: ReadonlySet<string>): T {
    if (!input || typeof input !== 'object') return input;
    const record = input as Record<string, unknown>;
    const isEnvelope = !!record.bindingsByServiceId && typeof record.bindingsByServiceId === 'object';
    const byServiceId = (isEnvelope ? record.bindingsByServiceId : record) as Record<string, unknown>;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [serviceId, binding] of Object.entries(byServiceId)) {
        if (!binding || typeof binding !== 'object') {
            next[serviceId] = binding;
            continue;
        }
        const kept = Object.fromEntries(Object.entries(binding).filter(([field]) => !fields.has(field)));
        if (Object.keys(kept).length !== Object.keys(binding).length) changed = true;
        next[serviceId] = kept;
    }
    if (!changed) return input;
    return (isEnvelope ? { ...record, bindingsByServiceId: next } : next) as T;
}

const INTERNAL_ASSIGNMENT_FIELD_SET: ReadonlySet<string> = new Set(CONNECTED_SERVICE_INTERNAL_ASSIGNMENT_FIELDS);

/** What a child, fork, handoff target or stored default never inherits: every internal field plus the parent's request. */
export const CONNECTED_SERVICE_INHERITANCE_STRIPPED_FIELDS = Object.freeze([
    ...CONNECTED_SERVICE_INTERNAL_ASSIGNMENT_FIELDS,
    'initialProfileId',
] as const);

const INHERITANCE_STRIPPED_FIELD_SET: ReadonlySet<string> = new Set(CONNECTED_SERVICE_INHERITANCE_STRIPPED_FIELDS);

/**
 * Removes caller-supplied internal assignment state (CONNECTED_SERVICE_INTERNAL_ASSIGNMENT_FIELDS) and
 * keeps `initialProfileId`. Accepts a V1 envelope or bare bindingsByServiceId record and returns the
 * same shape; returns the input itself when nothing is removed.
 */
export function stripConnectedServiceInternalAssignmentFields<T>(input: T): T {
    return omitConnectedServiceBindingFields(input, INTERNAL_ASSIGNMENT_FIELD_SET);
}

/**
 * The group/source a child, fork, handoff target or stored default inherits: the parent's
 * `initialProfileId` and every internal assignment field removed (spec A.1); the inheritor makes its
 * own decision and reservation. Accepts a V1 envelope or bare record and returns the same shape;
 * returns the input itself when nothing is removed.
 */
export function stripConnectedServicePerSessionAssignmentFields<T>(input: T): T {
    return omitConnectedServiceBindingFields(input, INHERITANCE_STRIPPED_FIELD_SET);
}
