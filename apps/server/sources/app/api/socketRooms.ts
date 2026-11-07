import { ConnectedServiceIdSchema, readConnectedServiceReaderSupport } from "@happier-dev/protocol";

export type SocketClientType = "session-scoped" | "user-scoped" | "machine-scoped";

export const RELEASED_CONNECTED_SERVICE_READER_ROOM = "connected-services-reader:released";
export const CURRENT_CONNECTED_SERVICE_READER_ROOM = "connected-services-reader:current";

export function getConnectedServiceReaderRoom(raw: unknown): string {
    const supportedIds = readConnectedServiceReaderSupport(raw);
    return ConnectedServiceIdSchema.options.every(serviceId => supportedIds.includes(serviceId))
        ? CURRENT_CONNECTED_SERVICE_READER_ROOM
        : RELEASED_CONNECTED_SERVICE_READER_ROOM;
}

export function getSocketRooms(params: {
    userId: string;
    clientType: SocketClientType;
    sessionId?: string | undefined;
    machineId?: string | undefined;
    connectedServiceIds?: unknown;
}): string[] {
    if (!params.userId) {
        throw new Error("getSocketRooms: userId is required");
    }

    const rooms: string[] = [];

    if (params.clientType === "user-scoped") {
        rooms.push(`user:${params.userId}`);
        rooms.push(`user-scoped:${params.userId}`);
    }

    if (params.clientType === "session-scoped") {
        if (!params.sessionId) {
            throw new Error("getSocketRooms: sessionId is required for session-scoped clients");
        }
        rooms.push(`user:${params.userId}`);
        // Important: `session:${sessionId}` is a shared room across participants and must never receive per-account `update`
        // containers (they contain per-account cursors and may contain recipient-specific data). We still join it for future
        // broadcast-safe session events.
        rooms.push(`session:${params.sessionId}`);

        // Per-account session room (safe for recipient-specific updates).
        rooms.push(`session:${params.sessionId}:${params.userId}`);
    }

    if (params.clientType === "machine-scoped") {
        if (!params.machineId) {
            throw new Error("getSocketRooms: machineId is required for machine-scoped clients");
        }
        // Machine daemons should not subscribe to the generic user room. That room is the fanout target
        // for "all authenticated connections" events, and Bun's long-lived socket clients retain native
        // memory aggressively under websocket churn. Keep machine daemons on the dedicated per-machine room.
        rooms.push(`user-machines:${params.userId}`);
        rooms.push(`machine:${params.machineId}:${params.userId}`);
    }

    // Reader rooms are exclusion cohorts only; emission remains scoped to the
    // original account/session/machine rooms, preserving participant isolation.
    rooms.push(getConnectedServiceReaderRoom(params.connectedServiceIds));
    return rooms;
}
