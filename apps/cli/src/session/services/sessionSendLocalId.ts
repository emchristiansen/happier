import { createHmac } from 'node:crypto';

import { readPendingLocalId, type PendingRequestedActionV1 } from '@happier-dev/protocol';

/**
 * Derives the Pending localId of a `session.message.send` whose caller did not
 * key it, so that a resend of the same request becomes the same relay row
 * instead of a second message. The relay deduplicates Pending and transcript
 * rows by (session, localId).
 *
 * Precedence (applied by the caller): an explicit caller localId, then a
 * provider tool-call id, then the time bucket below.
 *
 * - A provider tool-call id (Claude's `_meta["claudecode/toolUseId"]`, Pi's
 *   tool call id) identifies one call across that provider's retries, so the
 *   localId is a digest of it and the request, with no time component.
 * - Otherwise the localId is a digest of the request and its 10-minute UTC
 *   time bucket: every identical send in the same bucket is the same message.
 *   That is the accepted cost: a retry that crosses a bucket boundary is sent
 *   once more, and an identical send meant as a repeat inside one bucket is
 *   collapsed into the first.
 *
 * Both digests are HMAC-SHA256 keyed by the target session's client-side
 * encryption key. The localId travels to the relay in clear even for
 * end-to-end encrypted sessions; an unkeyed hash of a short message text
 * would let anyone holding the localId confirm a guessed text.
 */

export const SESSION_SEND_BUCKET_MS = 10 * 60_000;

export const SESSION_SEND_TEXT_LOCAL_ID_PREFIX = 'session-send-text:';
export const SESSION_SEND_TOOL_CALL_LOCAL_ID_PREFIX = 'session-send-tool-call:';

const TEXT_BUCKET_DOMAIN = 'happier.session-send.local-id.text-bucket.v1';
const TOOL_CALL_DOMAIN = 'happier.session-send.local-id.tool-call.v1';

/** Who is sending, for keying an unkeyed send. */
export type SessionSendDerivationIdentity = Readonly<{
  /** The session (or `cli-global`) on whose behalf the send runs. */
  senderSessionId: string;
  /** Provider-assigned id of the invoking tool call; null when the transport exposes none. */
  providerToolCallId: string | null;
}>;

/** Everything the caller supplied that decides what the send enqueues. */
export type SessionSendRequestInputs = Readonly<{
  message: string;
  requestedAction: PendingRequestedActionV1 | null;
  permissionModeOverride: string | null;
  modelOverride: Readonly<{ set: false }> | Readonly<{ set: true; value: string | null }>;
  pendingAdmissionMode: string | null;
}>;

/**
 * Start of the 10-minute bucket containing `nowMs`. Epoch milliseconds are UTC
 * by definition, so buckets are `[k * 600000, (k + 1) * 600000)` ms since
 * 1970-01-01T00:00:00Z, independent of the host time zone.
 */
export function resolveSessionSendBucketStartMs(nowMs: number): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('session_send_clock_invalid');
  return Math.floor(nowMs / SESSION_SEND_BUCKET_MS) * SESSION_SEND_BUCKET_MS;
}

function hmacHex(key: Uint8Array, material: readonly unknown[]): string {
  return createHmac('sha256', key).update(JSON.stringify(material)).digest('hex');
}

function requestMaterial(inputs: SessionSendRequestInputs): unknown[] {
  return [
    inputs.message,
    inputs.requestedAction,
    inputs.permissionModeOverride,
    inputs.modelOverride.set ? ['set', inputs.modelOverride.value] : ['unset'],
    inputs.pendingAdmissionMode,
  ];
}

export function deriveSessionSendLocalId(params: Readonly<{
  /** The target session's client-side encryption key (never sent to the relay). */
  key: Uint8Array;
  targetSessionId: string;
  identity: SessionSendDerivationIdentity;
  inputs: SessionSendRequestInputs;
  nowMs: number;
}>): string {
  if (!params.targetSessionId.trim() || !params.identity.senderSessionId.trim()) {
    throw new Error('session_send_identity_invalid');
  }
  if (params.key.length === 0) throw new Error('session_send_key_invalid');
  const toolCallId = params.identity.providerToolCallId?.trim() || null;
  const localId = toolCallId
    ? `${SESSION_SEND_TOOL_CALL_LOCAL_ID_PREFIX}${hmacHex(params.key, [
        TOOL_CALL_DOMAIN,
        params.targetSessionId,
        params.identity.senderSessionId,
        toolCallId,
        ...requestMaterial(params.inputs),
      ]).slice(0, 32)}`
    : `${SESSION_SEND_TEXT_LOCAL_ID_PREFIX}${hmacHex(params.key, [
        TEXT_BUCKET_DOMAIN,
        params.targetSessionId,
        params.identity.senderSessionId,
        resolveSessionSendBucketStartMs(params.nowMs),
        ...requestMaterial(params.inputs),
      ]).slice(0, 32)}`;
  const validated = readPendingLocalId(localId);
  if (validated === null) throw new Error('session_send_local_id_invalid');
  return validated;
}
