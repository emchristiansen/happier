import type {
  SessionPendingInputMarkHandledReadbackV1,
  SessionPendingInputMarkHandledRejectionKindV1,
  SessionPendingInputMarkHandledRequestV1,
  SessionPendingInputMarkHandledResultV1,
  SessionPendingInputRowSnapshotV1,
} from '@happier-dev/protocol';

import { INVALID_RESPONSE_SHAPE_CODE, isPermanentRequestStatus } from '@/api/client/httpStatusError';
import {
  markPendingQueueV2DeliveryHandled,
  readPendingQueueV2RowSnapshotsFromServer,
  type PendingQueueV2RowSnapshot,
} from '@/api/session/pendingQueueV2Transport';
import type { Credentials } from '@/persistence';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';

type HttpFailure = Readonly<{ httpStatus: number | null; errorCode: string | null }>;
type ReceiptBase = Pick<SessionPendingInputMarkHandledResultV1, 'sessionId' | 'localId' | 'expectation' | 'claimsDelivery'>;
type PostedReceipt = Exclude<SessionPendingInputMarkHandledResultV1, { outcome: 'refused' }>;
type PickPostOutcome<Receipt> = Receipt extends unknown ? Pick<Receipt, Extract<keyof Receipt, 'outcome' | 'post'>> : never;
/** What the single POST produced, one variant per posted receipt outcome. */
type PostOutcome = PickPostOutcome<PostedReceipt>;

const SAFE_SERVER_ERROR = /^[A-Za-z0-9_.:-]{1,160}$/u;

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The HTTP status and error code an Axios-shaped error carries, without its message or request. */
function describeHttpFailure(error: unknown): HttpFailure {
  const record = readRecord(error);
  const status = readRecord(record?.response)?.status;
  const code = record?.code;
  return {
    httpStatus: typeof status === 'number' && Number.isInteger(status) ? status : null,
    errorCode: typeof code === 'string' && code.length > 0 ? code : null,
  };
}

function readServerError(error: unknown): string | null {
  const serverError = readRecord(readRecord(readRecord(error)?.response)?.data)?.error;
  return typeof serverError === 'string' && SAFE_SERVER_ERROR.test(serverError) ? serverError : null;
}

function classifyRejection(httpStatus: number, serverError: string | null): SessionPendingInputMarkHandledRejectionKindV1 {
  if (httpStatus === 409 && serverError === 'transcript-conflict') return 'transcript_conflict';
  if (httpStatus === 400) return 'invalid_params';
  if (httpStatus === 401) return 'unauthenticated';
  if (httpStatus === 403) return 'forbidden';
  if (httpStatus === 404 && serverError === 'session-not-found') return 'session_not_found';
  return 'other_client_error';
}

/**
 * A final client-error status means the server read the request and refused it. Every other
 * failure leaves open whether the resolution was committed, so it is reported as uncertain.
 */
function classifyPostFailure(error: unknown): PostOutcome {
  const failure = describeHttpFailure(error);
  if (failure.httpStatus !== null && isPermanentRequestStatus(failure.httpStatus)) {
    const serverError = readServerError(error);
    return {
      outcome: 'rejected',
      post: {
        errorKind: classifyRejection(failure.httpStatus, serverError),
        httpStatus: failure.httpStatus,
        serverError,
      },
    };
  }
  if (failure.httpStatus !== null) {
    return { outcome: 'uncertain', post: { errorKind: 'non_final_status', ...failure } };
  }
  if (failure.errorCode === INVALID_RESPONSE_SHAPE_CODE) {
    return { outcome: 'uncertain', post: { errorKind: 'malformed_response', ...failure } };
  }
  return { outcome: 'uncertain', post: { errorKind: 'transport_failure', ...failure } };
}

function toRowSnapshot(row: PendingQueueV2RowSnapshot): SessionPendingInputRowSnapshotV1 {
  return {
    localId: row.localId,
    status: row.status,
    deliveryState: row.deliveryState,
    deliveryBlockedReason: row.deliveryBlockedReason,
    position: row.position,
  };
}

function matchesExpectation(row: PendingQueueV2RowSnapshot, request: SessionPendingInputMarkHandledRequestV1): boolean {
  if (row.status !== 'queued') return false;
  if (row.deliveryState !== request.expectedDeliveryState) return false;
  return request.expectedBlockedReason === undefined || row.deliveryBlockedReason === request.expectedBlockedReason;
}

async function readBack(token: string, sessionId: string, localId: string): Promise<SessionPendingInputMarkHandledReadbackV1> {
  const [rows, session] = await Promise.allSettled([
    readPendingQueueV2RowSnapshotsFromServer({ token, sessionId }),
    fetchSessionById({ token, sessionId }),
  ]);

  const pendingRows: SessionPendingInputMarkHandledReadbackV1['pendingRows'] = rows.status === 'fulfilled'
    ? (() => {
        const row = rows.value.find((candidate) => candidate.localId === localId) ?? null;
        return {
          status: 'read',
          row: row ? toRowSnapshot(row) : null,
          rowGoneFromQueuedList: row?.status !== 'queued',
        };
      })()
    : { status: 'failed', ...describeHttpFailure(rows.reason) };

  const sessionCounts: SessionPendingInputMarkHandledReadbackV1['sessionCounts'] = session.status === 'rejected'
    ? { status: 'failed', ...describeHttpFailure(session.reason) }
    : session.value === null
      ? { status: 'failed', httpStatus: 404, errorCode: 'session_not_found' }
      : {
          status: 'read',
          pendingCount: session.value.pendingCount ?? null,
          pendingBlockedCount: session.value.pendingBlockedCount ?? null,
          pendingVersion: session.value.pendingVersion ?? null,
        };

  return { pendingRows, sessionCounts };
}

/**
 * Resolves one pending input as manually handled through the server's handled route.
 *
 * The route itself checks only that the row is in a resolvable state; it has no compare-and-set
 * on the state the caller observed. This function therefore refuses unless a fresh read shows
 * the row in exactly the expected state, posts once (never retrying), and reads the queue back.
 * Between the pre-read and the POST another writer can still move the row, so the pre-read does not
 * show the state the POST acted on. The committed transcript message in the POST response
 * establishes that this request resolved the row; the readback only reports what two later reads
 * observed. The receipt never claims delivery: the caller must hold that proof independently.
 */
export async function markSessionPendingInputHandled(params: Readonly<{
  credentials: Credentials | undefined;
  request: SessionPendingInputMarkHandledRequestV1;
}>): Promise<SessionPendingInputMarkHandledResultV1> {
  const { request } = params;
  const base: ReceiptBase = {
    sessionId: request.sessionId,
    localId: request.localId,
    expectation: {
      deliveryState: request.expectedDeliveryState,
      blockedReason: request.expectedBlockedReason ?? null,
    },
    claimsDelivery: false,
  };

  if (!params.credentials) {
    return { ...base, outcome: 'refused', refusal: { reason: 'not_authenticated' } };
  }
  const token = params.credentials.token;

  let preReadRows: PendingQueueV2RowSnapshot[];
  try {
    preReadRows = await readPendingQueueV2RowSnapshotsFromServer({ token, sessionId: request.sessionId });
  } catch (error) {
    return { ...base, outcome: 'refused', refusal: { reason: 'pre_read_failed', ...describeHttpFailure(error) } };
  }
  const preReadRow = preReadRows.find((row) => row.localId === request.localId);
  if (!preReadRow) {
    return { ...base, outcome: 'refused', refusal: { reason: 'row_missing' } };
  }
  const preRead = toRowSnapshot(preReadRow);
  if (!matchesExpectation(preReadRow, request)) {
    return { ...base, outcome: 'refused', refusal: { reason: 'state_mismatch', row: preRead } };
  }

  let postOutcome: PostOutcome;
  try {
    const posted = await markPendingQueueV2DeliveryHandled({
      token,
      sessionId: request.sessionId,
      localId: request.localId,
    });
    postOutcome = posted.transcriptMessage === null
      ? {
          outcome: 'not_resolved',
          post: {
            pendingCount: posted.pendingQueueState.pendingCount,
            pendingBlockedCount: posted.pendingQueueState.pendingBlockedCount,
            pendingVersion: posted.pendingQueueState.pendingVersion,
          },
        }
      : {
          outcome: 'resolved',
          post: {
            pendingCount: posted.pendingQueueState?.pendingCount ?? null,
            pendingBlockedCount: posted.pendingQueueState?.pendingBlockedCount ?? null,
            pendingVersion: posted.pendingQueueState?.pendingVersion ?? null,
            transcriptMessage: posted.transcriptMessage,
          },
        };
  } catch (error) {
    postOutcome = classifyPostFailure(error);
  }

  const readback = await readBack(token, request.sessionId, request.localId);
  return { ...base, preRead, readback, ...postOutcome };
}
