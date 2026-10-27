import { randomUUID } from 'node:crypto';

declare const sessionLaunchIdBrand: unique symbol;

/**
 * Identity of one physical runner launch attempt. A fresh value is minted for every
 * call that will produce a runner process (first spawn, resume, respawn). It is not
 * the request's `spawnNonce`, which is an idempotency and acknowledgement nonce that
 * coalesced requests can share, and it is never a Session ID.
 */
export type SessionLaunchId = string & { readonly [sessionLaunchIdBrand]: true };

export function createSessionLaunchId(): SessionLaunchId {
  return randomUUID() as SessionLaunchId;
}

/** The transient user scope one launch attempt asks systemd-run to create. */
export function sessionLaunchScopeUnitName(launchId: SessionLaunchId): string {
  return `happier-launch-${launchId}.scope`;
}
