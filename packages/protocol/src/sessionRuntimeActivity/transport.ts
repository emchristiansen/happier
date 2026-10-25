import { z } from 'zod';

import {
  SessionRuntimeActivityProjectionSchema,
  SessionRuntimeActivitySnapshotSchema,
} from './projection.js';

export const SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT = 'session-runtime-activity-snapshot';
export const SESSION_RUNTIME_ACTIVITY_CLOSE_EVENT = 'session-runtime-activity-close';
export const SESSION_PUBLISHER_LEGACY_ALIVE_EVENT = 'session-alive';
export const SESSION_PUBLISHER_LEGACY_END_EVENT = 'session-end';

/** Released stable/preview CLI reachability vector, retained only at the machine-bound socket seam. */
export const SessionPublisherLegacyAliveSchema = z.object({
  sid: z.string().trim().min(1),
  time: z.number().finite(),
  thinking: z.boolean(),
  mode: z.enum(['local', 'remote']).optional(),
}).passthrough();

/** Released stable/preview CLI clean-end vector, retained only at the machine-bound socket seam. */
export const SessionPublisherLegacyEndSchema = z.object({
  sid: z.string().trim().min(1),
  time: z.number().finite(),
}).passthrough();

export type SessionPublisherLegacyAlive = z.infer<typeof SessionPublisherLegacyAliveSchema>;
export type SessionPublisherLegacyEnd = z.infer<typeof SessionPublisherLegacyEndSchema>;

const SessionRuntimeActivityTransportIdentitySchema = z.object({
  sessionId: z.string().trim().min(1),
  mutationId: z.string().trim().min(1),
}).strict();

export const SessionRuntimeActivitySnapshotRequestSchema = z.object({
  sessionId: z.string().trim().min(1),
  mutationId: z.string().trim().min(1),
  snapshot: SessionRuntimeActivitySnapshotSchema,
}).strict();

const SessionRuntimeActivitySnapshotAppliedAckSchema = SessionRuntimeActivityTransportIdentitySchema.extend({
  status: z.literal('applied'),
  projection: SessionRuntimeActivityProjectionSchema,
}).strict();

const SessionRuntimeActivitySnapshotUnchangedAckSchema = SessionRuntimeActivityTransportIdentitySchema.extend({
  status: z.literal('unchanged'),
  projection: SessionRuntimeActivityProjectionSchema,
}).strict();

const SessionRuntimeActivitySnapshotRejectedAckSchema = SessionRuntimeActivityTransportIdentitySchema.extend({
  status: z.literal('rejected'),
  reason: z.enum([
    'not_found',
    'unauthorized',
    'archived',
    'superseded',
    'revision_overflow',
  ]),
}).strict();

const SessionRuntimeActivitySnapshotInvalidRequestAckSchema = z.object({
  status: z.literal('rejected'),
  reason: z.literal('invalid_request'),
}).strict();

const SessionRuntimeActivitySnapshotRetryableAckSchema = SessionRuntimeActivityTransportIdentitySchema.extend({
  status: z.literal('retryable'),
  reason: z.literal('internal'),
}).strict();

export const SessionRuntimeActivitySnapshotAckSchema = z.union([
  SessionRuntimeActivitySnapshotAppliedAckSchema,
  SessionRuntimeActivitySnapshotUnchangedAckSchema,
  SessionRuntimeActivitySnapshotRejectedAckSchema,
  SessionRuntimeActivitySnapshotInvalidRequestAckSchema,
  SessionRuntimeActivitySnapshotRetryableAckSchema,
]);

export type SessionRuntimeActivitySnapshotRequest = z.infer<typeof SessionRuntimeActivitySnapshotRequestSchema>;
export type SessionRuntimeActivitySnapshotAck = z.infer<typeof SessionRuntimeActivitySnapshotAckSchema>;

export const SessionRuntimeActivityCloseRequestSchema = z.object({
  sessionId: z.string().trim().min(1),
}).strict();

export const SessionRuntimeActivityCloseAckSchema = z.union([
  z.object({ status: z.literal('closed'), sessionId: z.string().trim().min(1) }).strict(),
  z.object({ status: z.literal('already_inactive'), sessionId: z.string().trim().min(1) }).strict(),
  z.object({
    status: z.literal('rejected'),
    sessionId: z.string().trim().min(1),
    reason: z.enum(['not_found', 'unauthorized', 'archived', 'superseded']),
  }).strict(),
  z.object({
    status: z.literal('retryable'),
    sessionId: z.string().trim().min(1),
    reason: z.literal('internal'),
  }).strict(),
  z.object({ status: z.literal('rejected'), reason: z.literal('invalid_request') }).strict(),
]);

export type SessionRuntimeActivityCloseRequest = z.infer<typeof SessionRuntimeActivityCloseRequestSchema>;
export type SessionRuntimeActivityCloseAck = z.infer<typeof SessionRuntimeActivityCloseAckSchema>;

/**
 * Identity of one runner process acting as a session publisher. The runner sends it in its
 * session-scoped socket handshake (`publisherIncarnationId` in the auth payload) and reports it to
 * its daemon on `POST /session-started`, so a later exit report can name exactly that runner.
 */
export const SessionPublisherIncarnationIdSchema = z.string().trim().min(1).max(128);

/**
 * Machine-scoped proof that one exact runner incarnation exited. A dead runner cannot close its own
 * publisher fence, so the daemon that observed the exit asks the server to retire it. The server
 * retires the fence only while that incarnation's latest registration is still the current
 * publisher; a report that cannot be matched is rejected, never redirected to the current publisher.
 */
export const MACHINE_SESSION_RUNNER_EXITED_EVENT = 'machine-session-runner-exited';

export const MachineSessionRunnerExitedRequestSchema = z.object({
  sessionId: z.string().trim().min(1),
  publisherIncarnationId: SessionPublisherIncarnationIdSchema,
}).strict();

export const MachineSessionRunnerExitedAckSchema = z.union([
  z.object({ status: z.literal('closed'), sessionId: z.string().trim().min(1) }).strict(),
  z.object({ status: z.literal('already_inactive'), sessionId: z.string().trim().min(1) }).strict(),
  z.object({
    status: z.literal('rejected'),
    sessionId: z.string().trim().min(1),
    reason: z.enum(['not_found', 'machine_control_unavailable', 'archived', 'superseded', 'unmatched']),
  }).strict(),
  z.object({
    status: z.literal('retryable'),
    sessionId: z.string().trim().min(1),
    reason: z.literal('internal'),
  }).strict(),
  z.object({ status: z.literal('rejected'), reason: z.literal('invalid_request') }).strict(),
]);

export type MachineSessionRunnerExitedRequest = z.infer<typeof MachineSessionRunnerExitedRequestSchema>;
export type MachineSessionRunnerExitedAck = z.infer<typeof MachineSessionRunnerExitedAckSchema>;
