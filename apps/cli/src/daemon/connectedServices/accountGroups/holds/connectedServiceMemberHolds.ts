import { readFile } from 'node:fs/promises';
import { z } from 'zod';

import { configuration } from '@/configuration';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { lazySchema } from '@happier-dev/protocol';

/**
 * Externally known holds on connected-service group members.
 *
 * A hold is operator/placement knowledge that a member (one connected-service profile, i.e. one
 * stored credential) must not be selected by ordinary group selection, failover or spawn, even
 * though everything Happier itself has observed says it is eligible. It is keyed by profile, so it
 * applies in every group containing that profile. It never edits the member's enabled flag, the
 * group configuration or the provider account.
 *
 * Lifetime is explicit: an `until` hold stops applying at `untilMs` (evaluated against the
 * decision's own clock; no timer), an `until_released` hold applies until it is released.
 */

const HOLD_TEXT_MAX_LENGTH = 500;

export const ConnectedServiceMemberHoldLifetimeSchema = lazySchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('until'), untilMs: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('until_released') }).strict(),
]));

export type ConnectedServiceMemberHoldLifetime = z.infer<typeof ConnectedServiceMemberHoldLifetimeSchema>;

export const ConnectedServiceMemberHoldSchema = lazySchema(() => z.object({
  serviceId: z.string().trim().min(1),
  profileId: z.string().trim().min(1),
  reason: z.string().trim().min(1).max(HOLD_TEXT_MAX_LENGTH),
  source: z.string().trim().min(1).max(HOLD_TEXT_MAX_LENGTH),
  heldAtMs: z.number().int().nonnegative(),
  lifetime: ConnectedServiceMemberHoldLifetimeSchema,
}).strict());

export type ConnectedServiceMemberHold = z.infer<typeof ConnectedServiceMemberHoldSchema>;

const ConnectedServiceMemberHoldFileSchema = lazySchema(() => z.object({
  v: z.literal(1),
  holds: z.array(ConnectedServiceMemberHoldSchema),
}).strict().superRefine((file, context) => {
  const seen = new Set<string>();
  for (const [index, hold] of file.holds.entries()) {
    const key = holdKey(hold.serviceId, hold.profileId);
    if (seen.has(key)) {
      context.addIssue({ code: 'custom', path: ['holds', index], message: `duplicate hold for ${hold.serviceId}/${hold.profileId}` });
    }
    seen.add(key);
  }
}));

type ConnectedServiceMemberHoldFile = z.infer<typeof ConnectedServiceMemberHoldFileSchema>;

/**
 * What a selection decision knows about holds for one service. `unreadable` is distinct from an
 * empty readable set: selection must not treat a hold file it cannot read as "no holds".
 */
export type ConnectedServiceMemberHoldView =
  | Readonly<{ status: 'readable'; holdsByProfileId: ReadonlyMap<string, ConnectedServiceMemberHold> }>
  | Readonly<{ status: 'unreadable'; error: string }>;

export const NO_CONNECTED_SERVICE_MEMBER_HOLDS: ConnectedServiceMemberHoldView = Object.freeze({
  status: 'readable',
  holdsByProfileId: new Map<string, ConnectedServiceMemberHold>(),
});

export type ConnectedServiceMemberHoldExclusion =
  | Readonly<{ reason: 'held'; retryAtMs: number | null; holdReason: string; holdSource: string }>
  | Readonly<{ reason: 'hold_state_unreadable'; retryAtMs: null }>;

export function isConnectedServiceMemberHoldActive(hold: ConnectedServiceMemberHold, nowMs: number): boolean {
  return hold.lifetime.kind === 'until_released' || hold.lifetime.untilMs > nowMs;
}

/** The one rule deciding whether a member is excluded by holds at `nowMs`. */
export function resolveConnectedServiceMemberHoldExclusion(
  view: ConnectedServiceMemberHoldView,
  profileId: string,
  nowMs: number,
): ConnectedServiceMemberHoldExclusion | null {
  if (view.status === 'unreadable') return { reason: 'hold_state_unreadable', retryAtMs: null };
  const hold = view.holdsByProfileId.get(profileId);
  if (!hold || !isConnectedServiceMemberHoldActive(hold, nowMs)) return null;
  return {
    reason: 'held',
    retryAtMs: hold.lifetime.kind === 'until' ? hold.lifetime.untilMs : null,
    holdReason: hold.reason,
    holdSource: hold.source,
  };
}

function holdKey(serviceId: string, profileId: string): string {
  return `${serviceId}\u0000${profileId}`;
}

type HoldFileRead =
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'readable'; file: ConnectedServiceMemberHoldFile }>
  | Readonly<{ status: 'unreadable'; error: string }>;

async function readHoldFile(filePath: string): Promise<HoldFileRead> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { status: 'absent' };
    return { status: 'unreadable', error: `cannot read ${filePath}: ${(error as Error)?.message ?? String(error)}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return { status: 'unreadable', error: `invalid JSON in ${filePath}: ${(error as Error)?.message ?? String(error)}` };
  }
  const parsed = ConnectedServiceMemberHoldFileSchema.safeParse(json);
  if (!parsed.success) {
    return { status: 'unreadable', error: `invalid member hold file ${filePath}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}` };
  }
  return { status: 'readable', file: parsed.data };
}

export class ConnectedServiceMemberHoldFileUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectedServiceMemberHoldFileUnreadableError';
  }
}

export type ConnectedServiceMemberHoldStore = Readonly<{
  readForService(serviceId: string): Promise<ConnectedServiceMemberHoldView>;
  /** All holds, including expired ones; throws when the file cannot be read. */
  list(): Promise<ReadonlyArray<ConnectedServiceMemberHold>>;
  /** Creates or replaces the hold for this service/profile. Refuses to overwrite an unreadable file. */
  set(hold: ConnectedServiceMemberHold): Promise<Readonly<{ previous: ConnectedServiceMemberHold | null }>>;
  /** Removes the hold for this service/profile, if any. Refuses to rewrite an unreadable file. */
  release(input: Readonly<{ serviceId: string; profileId: string }>): Promise<Readonly<{ released: ConnectedServiceMemberHold | null }>>;
}>;

const HOLD_FILE_LOCK_TIMEOUT_MS = 10_000;
const HOLD_FILE_LOCK_STALE_MS = 30_000;

export function createConnectedServiceMemberHoldStore(input: Readonly<{ filePath: string }>): ConnectedServiceMemberHoldStore {
  const filePath = input.filePath;

  const readStrict = async (): Promise<ConnectedServiceMemberHoldFile> => {
    const read = await readHoldFile(filePath);
    if (read.status === 'unreadable') throw new ConnectedServiceMemberHoldFileUnreadableError(read.error);
    return read.status === 'absent' ? { v: 1, holds: [] } : read.file;
  };

  const mutate = async <T>(change: (file: ConnectedServiceMemberHoldFile) => Readonly<{ next: ConnectedServiceMemberHoldFile | null; result: T }>): Promise<T> => (
    await withJsonOwnerFileLock({
      lockPath: `${filePath}.lock`,
      timeoutMs: HOLD_FILE_LOCK_TIMEOUT_MS,
      staleAfterMs: HOLD_FILE_LOCK_STALE_MS,
      errorCode: 'connected_service_member_hold_file_lock_timeout',
    }, async () => {
      const { next, result } = change(await readStrict());
      if (next) await writeJsonAtomic(filePath, ConnectedServiceMemberHoldFileSchema.parse(next));
      return result;
    })
  );

  return {
    async readForService(serviceId) {
      const read = await readHoldFile(filePath);
      if (read.status === 'unreadable') return { status: 'unreadable', error: read.error };
      if (read.status === 'absent') return NO_CONNECTED_SERVICE_MEMBER_HOLDS;
      return {
        status: 'readable',
        holdsByProfileId: new Map(read.file.holds
          .filter((hold) => hold.serviceId === serviceId)
          .map((hold) => [hold.profileId, hold] as const)),
      };
    },
    async list() {
      return (await readStrict()).holds;
    },
    async set(hold) {
      const parsed = ConnectedServiceMemberHoldSchema.parse(hold);
      return await mutate((file) => {
        const key = holdKey(parsed.serviceId, parsed.profileId);
        const previous = file.holds.find((item) => holdKey(item.serviceId, item.profileId) === key) ?? null;
        return {
          next: { v: 1, holds: [...file.holds.filter((item) => holdKey(item.serviceId, item.profileId) !== key), parsed] },
          result: { previous },
        };
      });
    },
    async release(target) {
      const key = holdKey(target.serviceId.trim(), target.profileId.trim());
      return await mutate((file) => {
        const released = file.holds.find((item) => holdKey(item.serviceId, item.profileId) === key) ?? null;
        return {
          next: released ? { v: 1, holds: file.holds.filter((item) => item !== released) } : null,
          result: { released },
        };
      });
    },
  };
}

let configuredStore: Readonly<{ filePath: string; store: ConnectedServiceMemberHoldStore }> | null = null;

/** The canonical hold store for this Happier home (daemon and `happier connect hold` share it). */
export function getConfiguredConnectedServiceMemberHoldStore(): ConnectedServiceMemberHoldStore {
  const filePath = configuration.connectedServiceMemberHoldsFile;
  if (configuredStore?.filePath !== filePath) {
    configuredStore = { filePath, store: createConnectedServiceMemberHoldStore({ filePath }) };
  }
  return configuredStore.store;
}

/** Default hold reader for production selection paths; tests may inject their own. */
export async function readConfiguredConnectedServiceMemberHolds(serviceId: string): Promise<ConnectedServiceMemberHoldView> {
  return await getConfiguredConnectedServiceMemberHoldStore().readForService(serviceId);
}

/** Spawn refused because the group's active member is held (or holds could not be read). */
export class ConnectedServiceGroupMemberHeldForSpawnError extends Error {
  readonly code = 'connected_service_group_member_held' as const;
  readonly serviceId: string;
  readonly groupId: string;
  readonly profileId: string;
  readonly exclusion: ConnectedServiceMemberHoldExclusion;

  constructor(input: Readonly<{
    serviceId: string;
    groupId: string;
    profileId: string;
    exclusion: ConnectedServiceMemberHoldExclusion;
    unreadableError: string | null;
  }>) {
    const detail = input.exclusion.reason === 'held'
      ? `held (${input.exclusion.holdReason}; source ${input.exclusion.holdSource}; ${input.exclusion.retryAtMs === null ? 'until released' : `until ${new Date(input.exclusion.retryAtMs).toISOString()}`})`
      : `hold state unreadable (${input.unreadableError ?? 'unknown error'})`;
    super(`Connected service group ${input.serviceId}/${input.groupId} has no eligible member to spawn: active member ${input.profileId} is ${detail}`);
    this.name = 'ConnectedServiceGroupMemberHeldForSpawnError';
    this.serviceId = input.serviceId;
    this.groupId = input.groupId;
    this.profileId = input.profileId;
    this.exclusion = input.exclusion;
  }
}

/**
 * A switch commit refused at admission because its target became held (or hold state became
 * unreadable) after selection. Nothing was written; the coordinator reloads current holds and
 * reselects or terminates truthfully.
 */
export class ConnectedServiceMemberHeldAtSwitchAdmissionError extends Error {
  readonly code = 'connected_service_member_held_at_switch_admission' as const;
  readonly serviceId: string;
  readonly groupId: string;
  readonly profileId: string;
  readonly exclusion: ConnectedServiceMemberHoldExclusion;

  constructor(input: Readonly<{
    serviceId: string;
    groupId: string;
    profileId: string;
    exclusion: ConnectedServiceMemberHoldExclusion;
  }>) {
    super(`Connected service switch to ${input.serviceId}/${input.groupId}/${input.profileId} refused at admission: ${input.exclusion.reason}`);
    this.name = 'ConnectedServiceMemberHeldAtSwitchAdmissionError';
    this.serviceId = input.serviceId;
    this.groupId = input.groupId;
    this.profileId = input.profileId;
    this.exclusion = input.exclusion;
  }
}

/**
 * Whether member holds govern an automatic application of an already-committed generation.
 * Only a fresh user action is the operator's explicit choice; passive projection, catch-up and
 * runtime recovery are automatic even when an upstream label says `manual`. Derive this from the
 * execution authority, never from a switch-reason label.
 */
export type ConnectedServiceMemberHoldAdmission = 'enforce' | 'explicit_operator_choice';

export function resolveConnectedServiceMemberHoldAdmission(
  executionAuthority: 'passive_projection' | 'fresh_user_action' | 'runtime_recovery',
): ConnectedServiceMemberHoldAdmission {
  return executionAuthority === 'fresh_user_action' ? 'explicit_operator_choice' : 'enforce';
}

/** The refusal an automatic application reports when its immutable target is held or unreadable. */
export function resolveConnectedServiceMemberHoldApplicationRefusal(input: Readonly<{
  view: ConnectedServiceMemberHoldView;
  profileId: string;
  nowMs: number;
}>): Readonly<{ errorCode: string; diagnostics: unknown }> | null {
  const exclusion = resolveConnectedServiceMemberHoldExclusion(input.view, input.profileId, input.nowMs);
  if (!exclusion) return null;
  return {
    errorCode: exclusion.reason === 'held' ? 'connected_service_member_held' : 'connected_service_member_hold_state_unreadable',
    diagnostics: { memberHold: { profileId: input.profileId, ...exclusion } },
  };
}
