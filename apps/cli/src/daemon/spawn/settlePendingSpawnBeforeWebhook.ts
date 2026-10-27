import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

import type { TrackedSession } from '../types';

/**
 * Settles a launch that is still waiting for its session webhook, because its runner
 * exited or errored first. Returns whether a pending launch was settled.
 *
 * The child's exit and error listeners are permanent: they also fire when an ordinary
 * session ends long after a successful webhook. Only a resolver still registered here
 * establishes a pending launch; `waitForSessionWebhook` removes it on success and on
 * timeout, so a `false` result alone does not tell prior success from timeout.
 */
export function settlePendingSpawnBeforeWebhook(params: Readonly<{
  pid: number;
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
  pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
  pidToSpawnWebhookTimeout: Map<number, NodeJS.Timeout>;
  result: SpawnSessionResult;
}>): boolean {
  const resolveSpawn = params.pidToSpawnResultResolver.get(params.pid);
  if (!resolveSpawn) return false;
  params.pidToSpawnResultResolver.delete(params.pid);
  const timeout = params.pidToSpawnWebhookTimeout.get(params.pid);
  if (timeout) clearTimeout(timeout);
  params.pidToSpawnWebhookTimeout.delete(params.pid);
  params.pidToAwaiter.delete(params.pid);
  resolveSpawn(params.result);
  return true;
}
