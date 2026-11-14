import type { Fastify } from "../../types";

import { parseIntEnv } from "@/config/env";
import { createServerFeatureGatedRouteApp } from "@/app/features/catalog/serverFeatureGate";
import { registerConnectedServiceCredentialRoutesV3 } from "./connectedServicesV3/registerConnectedServiceCredentialRoutesV3";
import { registerConnectedServiceAuthGroupRoutesV3 } from "./connectedServicesV3/registerConnectedServiceAuthGroupRoutesV3";
import { registerConnectedServiceAssignmentReservationRoutesV3 } from "./connectedServicesV3/registerConnectedServiceAssignmentReservationRoutesV3";
import { registerConnectedServiceRefreshLeaseRoutesV3 } from "./connectedServicesV2/registerConnectedServiceRefreshLeaseRoutesV2";

function resolveRefreshLeaseMaxMs(env: NodeJS.ProcessEnv): number {
    return parseIntEnv(env.CONNECTED_SERVICE_REFRESH_LEASE_MAX_MS, 5 * 60_000, { min: 5_000, max: 60 * 60_000 });
}

export function connectConnectedServicesV3Routes(app: Fastify): void {
    const refreshLeaseMaxMs = resolveRefreshLeaseMaxMs(process.env);

    registerConnectedServiceCredentialRoutesV3(app);
    registerConnectedServiceRefreshLeaseRoutesV3(app, { refreshLeaseMaxMs });
    const accountGroupsApp = createServerFeatureGatedRouteApp(app, "connectedServices.accountGroups", process.env);
    registerConnectedServiceAuthGroupRoutesV3(accountGroupsApp);
    registerConnectedServiceAssignmentReservationRoutesV3(accountGroupsApp);
}
