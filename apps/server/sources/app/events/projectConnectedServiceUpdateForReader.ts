import {
    projectConnectedServiceProfileForReader,
    projectSessionRuntimeIssueForReader,
    SessionRuntimeIssueV1Schema,
    type ConnectedServiceId,
} from "@happier-dev/protocol";

import type { UpdatePayload } from "./eventPayloadTypes";

/** Translate outward readable fields; encrypted settings/transcripts remain opaque. */
export function projectConnectedServiceUpdateForReader(payload: UpdatePayload, supportedIds: readonly ConnectedServiceId[]): UpdatePayload {
    if (payload.body.t === "update-account") {
        const sourceProjection = {
            connectedServicesV2: payload.body.connectedServicesV2,
            connectedServiceCredentialRevisionsV1: payload.body.connectedServiceCredentialRevisionsV1,
        };
        const projection = projectConnectedServiceProfileForReader(sourceProjection, supportedIds);
        return projection === sourceProjection ? payload : { ...payload, body: { ...payload.body, ...projection } };
    }
    if (payload.body.t === "update-session" && payload.body.lastRuntimeIssue) {
        const issue = SessionRuntimeIssueV1Schema.parse(payload.body.lastRuntimeIssue);
        const lastRuntimeIssue = projectSessionRuntimeIssueForReader(issue, supportedIds);
        return lastRuntimeIssue === issue ? payload : { ...payload, body: { ...payload.body, lastRuntimeIssue } };
    }
    return payload;
}
