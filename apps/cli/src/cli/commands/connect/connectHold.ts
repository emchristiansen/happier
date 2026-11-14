import { ConnectedServiceIdSchema } from '@happier-dev/protocol';

import {
  ConnectedServiceMemberHoldSchema,
  getConfiguredConnectedServiceMemberHoldStore,
  isConnectedServiceMemberHoldActive,
  type ConnectedServiceMemberHold,
  type ConnectedServiceMemberHoldStore,
} from '@/daemon/connectedServices/accountGroups/holds/connectedServiceMemberHolds';

export type ConnectHoldCommand =
  | Readonly<{ kind: 'help' }>
  | Readonly<{ kind: 'list'; json: boolean }>
  | Readonly<{ kind: 'set'; hold: ConnectedServiceMemberHold; json: boolean }>
  | Readonly<{ kind: 'release'; serviceId: string; profileId: string; json: boolean }>;

export const CONNECT_HOLD_USAGE = `Usage:
  happier connect hold set --service <serviceId> --profile <profileId> --reason <text> --source <text> (--until <ISO time|epoch ms> | --until-released) [--json]
  happier connect hold release --service <serviceId> --profile <profileId> [--json]
  happier connect hold list [--json]

A hold keeps ordinary account-group selection, failover and spawn off one connected-service profile
in every group that contains it, without changing the member's enabled flag or the account. An
--until hold stops applying at that time; an --until-released hold applies until released.`;

function readFlag(args: ReadonlyArray<string>, name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--') || value.trim().length === 0) {
    throw new Error(`${name} requires a value`);
  }
  return value.trim();
}

function requireFlag(args: ReadonlyArray<string>, name: string): string {
  const value = readFlag(args, name);
  if (value === null) throw new Error(`${name} is required`);
  return value;
}

function parseUntilMs(raw: string): number {
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new Error(`--until must be an ISO time or epoch milliseconds, got ${raw}`);
  return parsed;
}

export function parseConnectHoldArgs(args: ReadonlyArray<string>, nowMs: number): ConnectHoldCommand {
  const [action, ...rest] = args;
  const json = rest.includes('--json');
  switch (action) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return { kind: 'help' };
    case 'list':
      return { kind: 'list', json };
    case 'release':
      return {
        kind: 'release',
        serviceId: ConnectedServiceIdSchema.parse(requireFlag(rest, '--service')),
        profileId: requireFlag(rest, '--profile'),
        json,
      };
    case 'set': {
      const until = readFlag(rest, '--until');
      const untilReleased = rest.includes('--until-released');
      if ((until === null) === !untilReleased) throw new Error('exactly one of --until or --until-released is required');
      const lifetime = until === null
        ? { kind: 'until_released' as const }
        : { kind: 'until' as const, untilMs: parseUntilMs(until) };
      if (lifetime.kind === 'until' && lifetime.untilMs <= nowMs) {
        throw new Error('--until is not in the future; a hold that has already expired would have no effect');
      }
      return {
        kind: 'set',
        hold: ConnectedServiceMemberHoldSchema.parse({
          serviceId: ConnectedServiceIdSchema.parse(requireFlag(rest, '--service')),
          profileId: requireFlag(rest, '--profile'),
          reason: requireFlag(rest, '--reason'),
          source: requireFlag(rest, '--source'),
          heldAtMs: nowMs,
          lifetime,
        }),
        json,
      };
    }
    default:
      throw new Error(`Unknown connect hold action: ${action}`);
  }
}

function describeHold(hold: ConnectedServiceMemberHold, nowMs: number): string {
  const lifetime = hold.lifetime.kind === 'until_released'
    ? 'until released'
    : `until ${new Date(hold.lifetime.untilMs).toISOString()}`;
  const status = isConnectedServiceMemberHoldActive(hold, nowMs) ? 'active' : 'expired';
  return `${hold.serviceId}/${hold.profileId}: ${status}, ${lifetime}; reason: ${hold.reason}; source: ${hold.source}; held at ${new Date(hold.heldAtMs).toISOString()}`;
}

export async function runConnectHoldCommand(input: Readonly<{
  args: ReadonlyArray<string>;
  nowMs: number;
  store?: ConnectedServiceMemberHoldStore;
  write: (line: string) => void;
}>): Promise<void> {
  const command = parseConnectHoldArgs(input.args, input.nowMs);
  const store = input.store ?? getConfiguredConnectedServiceMemberHoldStore();
  switch (command.kind) {
    case 'help':
      input.write(CONNECT_HOLD_USAGE);
      return;
    case 'list': {
      const holds = await store.list();
      if (command.json) {
        input.write(JSON.stringify({ holds: holds.map((hold) => ({ ...hold, active: isConnectedServiceMemberHoldActive(hold, input.nowMs) })) }, null, 2));
        return;
      }
      if (holds.length === 0) input.write('No connected-service member holds.');
      for (const hold of holds) input.write(describeHold(hold, input.nowMs));
      return;
    }
    case 'set': {
      const { previous } = await store.set(command.hold);
      if (command.json) {
        input.write(JSON.stringify({ hold: command.hold, previous }, null, 2));
        return;
      }
      input.write(`${previous ? 'Replaced' : 'Set'} hold ${describeHold(command.hold, input.nowMs)}`);
      return;
    }
    case 'release': {
      const { released } = await store.release({ serviceId: command.serviceId, profileId: command.profileId });
      if (command.json) {
        input.write(JSON.stringify({ released }, null, 2));
        return;
      }
      input.write(released
        ? `Released hold ${describeHold(released, input.nowMs)}`
        : `No hold for ${command.serviceId}/${command.profileId}.`);
      return;
    }
  }
}
