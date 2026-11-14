import { z } from "zod";
import {
    ConnectedServiceAssignmentReservationConflictResponseV1Schema,
    ConnectedServiceAssignmentReservationDecisionIdSchema,
    ConnectedServiceAssignmentReservationDeleteResponseV1Schema,
    ConnectedServiceAssignmentReservationListResponseV1Schema,
    ConnectedServiceAssignmentReservationPutRequestV1Schema,
    ConnectedServiceAssignmentReservationPutResponseV1Schema,
    ConnectedServiceAssignmentReservationStateV1Schema,
    type ConnectedServiceAssignmentReservationV1,
} from "@happier-dev/protocol";

import type { Fastify } from "../../../types";
import { inTx, type Tx } from "@/storage/inTx";
import { createServerFeatureGatePreHandler } from "@/app/features/catalog/serverFeatureGate";
import { AuthGroupErrorResponseSchema, AuthGroupParamsSchema } from "./authGroupSchemas";

const NotFoundResponseSchema = z.object({ error: z.literal("not_found") });
const ReservationParamsSchema = AuthGroupParamsSchema.extend({
    decisionId: ConnectedServiceAssignmentReservationDecisionIdSchema,
});

type ReservationRow = Readonly<{
    decisionId: string;
    profileId: string;
    sessionId: string;
    ownerMachineId: string;
    state: string;
    createdAtMs: bigint;
    leaseUntilMs: bigint;
}>;

type ReservationGroup = Readonly<{ id: string; reservationRevision: number; updatedAt: Date }>;

function toReservation(row: ReservationRow): ConnectedServiceAssignmentReservationV1 {
    return {
        decisionId: row.decisionId,
        profileId: row.profileId,
        sessionId: row.sessionId,
        ownerMachineId: row.ownerMachineId,
        // Rows are only written through the PUT schema; a foreign value fails loudly here.
        state: ConnectedServiceAssignmentReservationStateV1Schema.parse(row.state),
        createdAtMs: Number(row.createdAtMs),
        leaseUntilMs: Number(row.leaseUntilMs),
    };
}

async function findReservationGroupInTx(tx: Tx, params: { accountId: string; serviceId: string; groupId: string }): Promise<ReservationGroup | null> {
    return tx.connectedServiceAuthGroup.findUnique({
        where: { accountId_vendor_groupId: { accountId: params.accountId, vendor: params.serviceId, groupId: params.groupId } },
        select: { id: true, reservationRevision: true, updatedAt: true },
    });
}

async function listLiveReservationsInTx(tx: Tx, groupDbId: string, nowMs: number): Promise<ConnectedServiceAssignmentReservationV1[]> {
    const rows = await tx.connectedServiceAssignmentReservation.findMany({
        where: { groupDbId, leaseUntilMs: { gt: BigInt(nowMs) } },
        orderBy: [{ createdAtMs: "asc" }, { decisionId: "asc" }],
    });
    return rows.map(toReservation);
}

async function pruneExpiredReservationsInTx(tx: Tx, groupDbId: string, nowMs: number): Promise<void> {
    // Expired rows are already invisible to counting, so pruning them does not change the revision.
    await tx.connectedServiceAssignmentReservation.deleteMany({
        where: { groupDbId, leaseUntilMs: { lte: BigInt(nowMs) } },
    });
}

/**
 * Advances the reservation revision. `expectedRevision` makes it a compare-and-swap (new decisions);
 * `updatedAt` is rewritten to its stored value so the group's own metadata is untouched.
 * Returns the new revision, or null when the compare-and-swap lost.
 */
async function bumpReservationRevisionInTx(tx: Tx, group: ReservationGroup, expectedRevision?: number): Promise<number | null> {
    const update = await tx.connectedServiceAuthGroup.updateMany({
        where: { id: group.id, ...(expectedRevision === undefined ? {} : { reservationRevision: expectedRevision }) },
        data: { reservationRevision: { increment: 1 }, updatedAt: group.updatedAt },
    });
    if (update.count !== 1) return null;
    const current = await tx.connectedServiceAuthGroup.findUniqueOrThrow({ where: { id: group.id }, select: { reservationRevision: true } });
    return current.reservationRevision;
}

async function readReservationRevisionInTx(tx: Tx, groupDbId: string): Promise<number> {
    const current = await tx.connectedServiceAuthGroup.findUniqueOrThrow({ where: { id: groupDbId }, select: { reservationRevision: true } });
    return current.reservationRevision;
}

/**
 * Shared assignment-reservation resource for per_session_softmax pools (spec A.3).
 *
 * This is shared counting, not a group switch: no operation here bumps group `generation`,
 * records an account-profile change, or writes member runtime state. Only entries with
 * `leaseUntilMs > now` are live. A new decision commits only against the caller's observed
 * `reservationRevision`; an existing decision keeps its target (profile, session, owner) forever
 * and may change only its state and lease, without the revision precondition.
 */
export function registerConnectedServiceAssignmentReservationRoutesV3(app: Fastify): void {
    const requireFeature = createServerFeatureGatePreHandler("connectedServices.poolPerSessionSoftmax");
    const base = "/v3/connect/:serviceId/groups/:groupId/assignment-reservations";

    app.get(base, {
        preHandler: [requireFeature, app.authenticate],
        schema: {
            params: AuthGroupParamsSchema,
            response: {
                200: ConnectedServiceAssignmentReservationListResponseV1Schema,
                404: z.union([NotFoundResponseSchema, AuthGroupErrorResponseSchema]),
            },
        },
    }, async (request, reply) => {
        const nowMs = Date.now();
        const result = await inTx(async (tx) => {
            const group = await findReservationGroupInTx(tx, { accountId: request.userId, ...request.params });
            if (!group) return null;
            return {
                reservationRevision: group.reservationRevision,
                reservations: await listLiveReservationsInTx(tx, group.id, nowMs),
            };
        });
        if (!result) return reply.code(404).send({ error: "connect_group_not_found" });
        return reply.send(result);
    });

    app.put(`${base}/:decisionId`, {
        preHandler: [requireFeature, app.authenticate],
        schema: {
            params: ReservationParamsSchema,
            body: ConnectedServiceAssignmentReservationPutRequestV1Schema,
            response: {
                200: ConnectedServiceAssignmentReservationPutResponseV1Schema,
                400: AuthGroupErrorResponseSchema,
                404: z.union([NotFoundResponseSchema, AuthGroupErrorResponseSchema]),
                409: ConnectedServiceAssignmentReservationConflictResponseV1Schema,
            },
        },
    }, async (request, reply) => {
        const { serviceId, groupId, decisionId } = request.params;
        const body = request.body;
        const nowMs = Date.now();
        const result = await inTx(async (tx) => {
            const group = await findReservationGroupInTx(tx, { accountId: request.userId, serviceId, groupId });
            if (!group) return { type: "not-found" as const };
            await pruneExpiredReservationsInTx(tx, group.id, nowMs);
            const conflict = async (error: "assignment_reservation_conflict" | "assignment_reservation_decision_mismatch") => ({
                type: "conflict" as const,
                body: {
                    error,
                    reservationRevision: await readReservationRevisionInTx(tx, group.id),
                    reservations: await listLiveReservationsInTx(tx, group.id, nowMs),
                },
            });

            const existing = await tx.connectedServiceAssignmentReservation.findUnique({
                where: { groupDbId_decisionId: { groupDbId: group.id, decisionId } },
            });
            if (existing) {
                if (existing.profileId !== body.profileId
                    || existing.sessionId !== body.sessionId
                    || existing.ownerMachineId !== body.ownerMachineId) {
                    return conflict("assignment_reservation_decision_mismatch");
                }
                if (existing.state === body.state && Number(existing.leaseUntilMs) === body.leaseUntilMs) {
                    return { type: "success" as const, outcome: "unchanged" as const, reservationRevision: group.reservationRevision, row: existing };
                }
            }

            const member = await tx.connectedServiceAuthGroupMember.findUnique({
                where: { accountId_vendor_groupId_profileId: { accountId: request.userId, vendor: serviceId, groupId, profileId: body.profileId } },
                select: { id: true },
            });
            if (!member || body.leaseUntilMs <= nowMs) return { type: "invalid" as const };

            if (existing) {
                const row = await tx.connectedServiceAssignmentReservation.update({
                    where: { id: existing.id },
                    data: { state: body.state, leaseUntilMs: BigInt(body.leaseUntilMs) },
                });
                const reservationRevision = await bumpReservationRevisionInTx(tx, group);
                if (reservationRevision === null) throw new Error("assignment reservation group disappeared inside its transaction");
                return { type: "success" as const, outcome: "updated" as const, reservationRevision, row };
            }

            const reservationRevision = await bumpReservationRevisionInTx(tx, group, body.expectedReservationRevision);
            if (reservationRevision === null) return conflict("assignment_reservation_conflict");
            const row = await tx.connectedServiceAssignmentReservation.create({
                data: {
                    groupDbId: group.id,
                    decisionId,
                    profileId: body.profileId,
                    sessionId: body.sessionId,
                    ownerMachineId: body.ownerMachineId,
                    state: body.state,
                    createdAtMs: BigInt(nowMs),
                    leaseUntilMs: BigInt(body.leaseUntilMs),
                },
            });
            return { type: "success" as const, outcome: "created" as const, reservationRevision, row };
        });

        if (result.type === "not-found") return reply.code(404).send({ error: "connect_group_not_found" });
        if (result.type === "invalid") return reply.code(400).send({ error: "assignment_reservation_invalid" });
        if (result.type === "conflict") return reply.code(409).send(result.body);
        return reply.send({
            reservationRevision: result.reservationRevision,
            reservation: toReservation(result.row),
            outcome: result.outcome,
        });
    });

    app.delete(`${base}/:decisionId`, {
        preHandler: [requireFeature, app.authenticate],
        schema: {
            params: ReservationParamsSchema,
            response: {
                200: ConnectedServiceAssignmentReservationDeleteResponseV1Schema,
                404: z.union([NotFoundResponseSchema, AuthGroupErrorResponseSchema]),
            },
        },
    }, async (request, reply) => {
        const { serviceId, groupId, decisionId } = request.params;
        const nowMs = Date.now();
        const result = await inTx(async (tx) => {
            const group = await findReservationGroupInTx(tx, { accountId: request.userId, serviceId, groupId });
            if (!group) return null;
            await pruneExpiredReservationsInTx(tx, group.id, nowMs);
            const removed = await tx.connectedServiceAssignmentReservation.deleteMany({
                where: { groupDbId: group.id, decisionId },
            });
            if (removed.count === 0) return { reservationRevision: group.reservationRevision, deleted: false };
            const reservationRevision = await bumpReservationRevisionInTx(tx, group);
            if (reservationRevision === null) throw new Error("assignment reservation group disappeared inside its transaction");
            return { reservationRevision, deleted: true };
        });
        if (!result) return reply.code(404).send({ error: "connect_group_not_found" });
        return reply.send(result);
    });
}
