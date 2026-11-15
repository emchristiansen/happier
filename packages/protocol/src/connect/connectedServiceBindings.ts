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

// An absolute POSIX or Windows path. The daemon resolves it again before use; this only refuses
// operands that could name a location relative to an unknown working directory.
const ConnectedServiceAbsolutePathSchema = lazySchema(() => z
    .string()
    .min(1)
    .refine((value) => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'), 'Expected an absolute path'));

/**
 * A native Codex source a new caller nominates for an `openai-codex` profile binding: the
 * configuration/state root and the SQLite home a fresh connected-service home is produced from,
 * instead of the spawning process's own environment. The binding's home is then a separate home of
 * that profile bound to exactly this pair (see the CLI's Codex native-source admission).
 */
export const ConnectedServiceCodexNativeSourceV1Schema = lazySchema(() => z
    .object({
        CODEX_HOME: ConnectedServiceAbsolutePathSchema,
        CODEX_SQLITE_HOME: ConnectedServiceAbsolutePathSchema,
    })
    .strict());

export type ConnectedServiceCodexNativeSourceV1 = z.infer<typeof ConnectedServiceCodexNativeSourceV1Schema>;

const CONNECTED_SERVICE_NATIVE_SOURCE_BINDING_KEY = 'nativeSource';

const ConnectedServiceProfileBindingV1Schema = lazySchema(() => z
    .object({
        source: z.literal('connected'),
        selection: z.literal('profile').optional().default('profile'),
        profileId: ConnectedServiceProfileIdSchema,
        nativeSource: ConnectedServiceCodexNativeSourceV1Schema.optional(),
    })
    .passthrough());

const ConnectedServiceGroupBindingV1Schema = lazySchema(() => z
    .object({
        source: z.literal('connected'),
        selection: z.literal('group'),
        groupId: ConnectedServiceAuthGroupIdSchema,
        profileId: ConnectedServiceProfileIdSchema.optional(),
        // Runtime account evidence; profileId remains the requested fallback.
        appliedProfileId: ConnectedServiceProfileIdSchema.optional(),
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
        for (const [serviceId, binding] of Object.entries(bindings)) {
            if (!ConnectedServiceIdSchema.safeParse(serviceId).success) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'Invalid connected service id',
                    path: [serviceId],
                });
            }
            // Bindings pass unknown fields through, so a nomination an owner cannot honour would
            // otherwise be silently ignored: only a connected openai-codex profile binding takes one.
            if (
                Object.prototype.hasOwnProperty.call(binding, CONNECTED_SERVICE_NATIVE_SOURCE_BINDING_KEY)
                && !(serviceId === 'openai-codex' && binding.source === 'connected' && binding.selection === 'profile')
            ) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'A native source may be nominated only on a connected openai-codex profile binding',
                    path: [serviceId, CONNECTED_SERVICE_NATIVE_SOURCE_BINDING_KEY],
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
