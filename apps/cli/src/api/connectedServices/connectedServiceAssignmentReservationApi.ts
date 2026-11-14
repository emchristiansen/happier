import axios, { type AxiosInstance } from 'axios';
import {
  ConnectedServiceAssignmentReservationConflictResponseV1Schema,
  ConnectedServiceAssignmentReservationDeleteResponseV1Schema,
  ConnectedServiceAssignmentReservationListResponseV1Schema,
  ConnectedServiceAssignmentReservationPutResponseV1Schema,
  appendConnectedServiceAuthGroupReaderCapabilities,
  type ConnectedServiceAssignmentReservationPutRequestV1,
  type ConnectedServiceAssignmentReservationV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

/**
 * Client for the per-group assignment-reservation resource (spec A.3).
 *
 * Results distinguish the custody outcomes the recovery contract depends on:
 * - `unavailable`: definitely nothing was committed (route 404/501, connection refused before send);
 *   only this permits local degraded selection.
 * - `conflict` / `decision_mismatch`: a definite 409; nothing was stored for this decision.
 * - `uncertain`: timeout, reset after send, 5xx or an unreadable body. The original decision and
 *   target must be kept and reconciled; it never permits a redraw.
 */
export type ConnectedServiceAssignmentReservationSnapshot = Readonly<{
  reservationRevision: number;
  reservations: ReadonlyArray<ConnectedServiceAssignmentReservationV1>;
}>;

export type ConnectedServiceAssignmentReservationListResult =
  | Readonly<{ kind: 'ok' } & ConnectedServiceAssignmentReservationSnapshot>
  | Readonly<{ kind: 'unavailable'; detail: string }>
  | Readonly<{ kind: 'uncertain'; detail: string }>;

export type ConnectedServiceAssignmentReservationPutResult =
  | Readonly<{
    kind: 'reserved';
    outcome: 'created' | 'updated' | 'unchanged';
    reservationRevision: number;
    reservation: ConnectedServiceAssignmentReservationV1;
  }>
  | Readonly<{ kind: 'conflict' } & ConnectedServiceAssignmentReservationSnapshot>
  | Readonly<{ kind: 'decision_mismatch' } & ConnectedServiceAssignmentReservationSnapshot>
  | Readonly<{ kind: 'unavailable'; detail: string }>
  | Readonly<{ kind: 'uncertain'; detail: string }>;

export type ConnectedServiceAssignmentReservationDeleteResult =
  | Readonly<{ kind: 'ok'; reservationRevision: number; deleted: boolean }>
  | Readonly<{ kind: 'unavailable'; detail: string }>
  | Readonly<{ kind: 'uncertain'; detail: string }>;

export type ConnectedServiceAssignmentReservationApi = Readonly<{
  listAssignmentReservations(params: Readonly<{ serviceId: ConnectedServiceId; groupId: string }>):
    Promise<ConnectedServiceAssignmentReservationListResult>;
  putAssignmentReservation(params: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    decisionId: string;
    body: ConnectedServiceAssignmentReservationPutRequestV1;
  }>): Promise<ConnectedServiceAssignmentReservationPutResult>;
  deleteAssignmentReservation(params: Readonly<{ serviceId: ConnectedServiceId; groupId: string; decisionId: string }>):
    Promise<ConnectedServiceAssignmentReservationDeleteResult>;
}>;

const DEFINITE_UNAVAILABLE_STATUSES = new Set([404, 501]);
const DEFINITE_PRE_SEND_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

function classifyTransportFailure(error: unknown): Readonly<{ kind: 'unavailable' | 'uncertain'; detail: string }> {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status !== undefined && DEFINITE_UNAVAILABLE_STATUSES.has(status)) {
      return { kind: 'unavailable', detail: `http_${status}` };
    }
    if (status === undefined && error.code && DEFINITE_PRE_SEND_ERROR_CODES.has(error.code)) {
      return { kind: 'unavailable', detail: error.code };
    }
    return { kind: 'uncertain', detail: status === undefined ? (error.code ?? 'transport_error') : `http_${status}` };
  }
  return { kind: 'uncertain', detail: error instanceof Error ? error.message : 'unknown_error' };
}

export function createConnectedServiceAssignmentReservationApi(input: Readonly<{
  serverUrl: string;
  token: string;
  timeoutMs: number;
  http?: Pick<AxiosInstance, 'get' | 'put' | 'delete'>;
}>): ConnectedServiceAssignmentReservationApi {
  const http = input.http ?? axios;
  const headers = { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json' };
  const baseUrl = (serviceId: ConnectedServiceId, groupId: string) =>
    `${input.serverUrl}/v3/connect/${encodeURIComponent(serviceId)}/groups/${encodeURIComponent(groupId)}/assignment-reservations`;
  const withCapabilities = (url: string) => appendConnectedServiceAuthGroupReaderCapabilities(url);

  return {
    async listAssignmentReservations(params) {
      try {
        const response = await http.get(withCapabilities(baseUrl(params.serviceId, params.groupId)), {
          headers,
          timeout: input.timeoutMs,
        });
        const parsed = ConnectedServiceAssignmentReservationListResponseV1Schema.safeParse(response.data);
        if (!parsed.success) return { kind: 'uncertain', detail: 'invalid_list_response' };
        return { kind: 'ok', ...parsed.data };
      } catch (error) {
        return classifyTransportFailure(error);
      }
    },

    async putAssignmentReservation(params) {
      try {
        const response = await http.put(
          withCapabilities(`${baseUrl(params.serviceId, params.groupId)}/${encodeURIComponent(params.decisionId)}`),
          params.body,
          { headers, timeout: input.timeoutMs },
        );
        const parsed = ConnectedServiceAssignmentReservationPutResponseV1Schema.safeParse(response.data);
        if (!parsed.success) return { kind: 'uncertain', detail: 'invalid_put_response' };
        return { kind: 'reserved', ...parsed.data };
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 409) {
          const parsed = ConnectedServiceAssignmentReservationConflictResponseV1Schema.safeParse(error.response.data);
          if (parsed.success) {
            const snapshot = { reservationRevision: parsed.data.reservationRevision, reservations: parsed.data.reservations };
            return parsed.data.error === 'assignment_reservation_conflict'
              ? { kind: 'conflict', ...snapshot }
              : { kind: 'decision_mismatch', ...snapshot };
          }
          return { kind: 'uncertain', detail: 'unreadable_409' };
        }
        return classifyTransportFailure(error);
      }
    },

    async deleteAssignmentReservation(params) {
      try {
        const response = await http.delete(
          withCapabilities(`${baseUrl(params.serviceId, params.groupId)}/${encodeURIComponent(params.decisionId)}`),
          { headers, timeout: input.timeoutMs },
        );
        const parsed = ConnectedServiceAssignmentReservationDeleteResponseV1Schema.safeParse(response.data);
        if (!parsed.success) return { kind: 'uncertain', detail: 'invalid_delete_response' };
        return { kind: 'ok', ...parsed.data };
      } catch (error) {
        return classifyTransportFailure(error);
      }
    },
  };
}
