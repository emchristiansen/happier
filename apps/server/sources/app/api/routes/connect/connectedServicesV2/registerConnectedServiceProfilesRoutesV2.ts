import { z } from "zod";

import type { Fastify } from "../../../types";
import { db } from "@/storage/db";
import {
  ConnectedServiceCredentialHealthV1Schema,
  ConnectedServiceIdSchema,
  type ConnectedServiceId,
} from "@happier-dev/protocol";

import { deriveConnectedServiceCredentialStatus } from "../credentialHealthMetadata";
import { readStoredConnectedServiceCredentialMetadata } from "../readStoredConnectedServiceCredentialMetadata";

export function registerConnectedServiceProfilesRoutesV2(app: Fastify): void {
  app.get("/v2/connect/:serviceId/profiles", {
    preHandler: app.authenticate,
    schema: {
      params: z.object({ serviceId: ConnectedServiceIdSchema }),
      response: {
        200: z.object({
          serviceId: ConnectedServiceIdSchema,
          profiles: z.array(z.object({
            profileId: z.string().min(1),
            status: z.enum(["connected", "refreshing", "needs_reauth", "refresh_failed_retryable"]),
            kind: z.enum(["oauth", "token"]).nullable().optional(),
            providerEmail: z.string().nullable().optional(),
            providerAccountId: z.string().nullable().optional(),
            expiresAt: z.number().int().nonnegative().nullable().optional(),
            lastUsedAt: z.number().int().nonnegative().nullable().optional(),
            health: ConnectedServiceCredentialHealthV1Schema.nullable().optional(),
          })),
        }),
      },
    },
  }, async (request, reply) => {
    const userId = request.userId;
    const serviceId = request.params.serviceId satisfies ConnectedServiceId;

    const rows = await db.serviceAccountToken.findMany({
      where: { accountId: userId, vendor: serviceId },
      orderBy: { updatedAt: "desc" },
      select: { profileId: true, metadata: true, expiresAt: true, lastUsedAt: true },
    });

    const profiles = rows.map((row) => {
      const metadata = readStoredConnectedServiceCredentialMetadata(row.metadata);
      return {
        profileId: row.profileId,
        status: deriveConnectedServiceCredentialStatus(metadata),
        kind: metadata?.kind ?? null,
        providerEmail: metadata?.providerEmail ?? null,
        providerAccountId: metadata?.providerAccountId ?? null,
        expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
        lastUsedAt: row.lastUsedAt ? row.lastUsedAt.getTime() : null,
        health: metadata?.health ?? null,
      };
    });

    return reply.send({ serviceId, profiles });
  });
}
