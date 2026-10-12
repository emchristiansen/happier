import type { Socket } from "socket.io";
import { z } from "zod";

import { readHappierSocketData } from "./socketData";

const UiFocusStateSchema = z.object({ computer: z.boolean(), focused: z.boolean() }).strict();

/** Focus belongs to this live sync socket; disconnect removes it with the socket. */
export function registerUiFocusSocketEvent(socket: Socket): void {
    socket.on("ui-focus", (input: unknown, ack?: (response: { ok: boolean }) => void) => {
        const data = readHappierSocketData(socket);
        const parsed = UiFocusStateSchema.safeParse(input);
        const allowed = data.clientType === "user-scoped" && data.clientPurpose === "sync";
        if (allowed && parsed.success) data.uiFocus = parsed.data;
        if (typeof ack === "function") ack({ ok: allowed && parsed.success });
    });
}
