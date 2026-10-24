import { randomUUID } from 'node:crypto';

/**
 * Identity of this runner process as a session publisher. It is sent in the session-scoped socket
 * handshake and reported to the daemon on `POST /session-started`, so when the daemon observes this
 * process exit it can ask the server to retire exactly this runner's publisher fence and no other.
 */
export const RUNNER_PUBLISHER_INCARNATION_ID: string = randomUUID();
