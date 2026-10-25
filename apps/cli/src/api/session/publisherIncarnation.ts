import { randomUUID } from 'node:crypto';

let runnerPublisherIncarnationId: string | undefined;

/**
 * Identity of this runner process as a session publisher. It is sent in the session-scoped socket
 * handshake and reported to the daemon on `POST /session-started`, so when the daemon observes this
 * process exit it can ask the server to retire exactly this runner's publisher fence and no other.
 *
 * The identifier is generated on first use and then returned unchanged for the rest of the process,
 * so every caller sees the same value while importing this module draws no random value.
 */
export function getRunnerPublisherIncarnationId(): string {
    runnerPublisherIncarnationId ??= randomUUID();
    return runnerPublisherIncarnationId;
}
