import type { Settings } from '@/persistence';
import { resolveMachineIdForServerFromSettings } from '@/daemon/resolveMachineIdForServerFromSettings';

/** Select the account's machine identity during setup through the strict resolver. */
export function selectMachineIdentityInSettings(settings: Settings, params: Readonly<{
  serverId: string;
  accountId: string | null;
  forceNew?: boolean;
  createMachineId: () => string;
}>): Settings {
  const { serverId } = params;
  const accountId = params.accountId?.trim() ?? '';
  const forceNew = params.forceNew ?? false;
  const nextMachineIdByServerId = { ...(settings.machineIdByServerId ?? {}) };
  const prevMachineIdForServer = nextMachineIdByServerId[serverId];
  const nextLastSubByServerId = { ...(settings.lastTokenSubByServerId ?? {}) };
  const nextConfirmed = { ...(settings.machineIdConfirmedByServerByServerId ?? {}) };
  const hadLastSub = serverId in nextLastSubByServerId;
  const hadConfirmed = serverId in nextConfirmed;

  if (!accountId) {
    const current = prevMachineIdForServer;
    if (hadLastSub) delete nextLastSubByServerId[serverId];
    if (hadConfirmed) delete nextConfirmed[serverId];

    if (forceNew || !current) {
      const machineId = params.createMachineId();
      nextMachineIdByServerId[serverId] = machineId;
      return {
        ...settings,
        machineIdByServerId: nextMachineIdByServerId,
        lastTokenSubByServerId: nextLastSubByServerId,
        machineIdConfirmedByServerByServerId: nextConfirmed,
        // derived (not persisted in v5+)
        machineId,
      };
    }

    if (!hadLastSub && !hadConfirmed) {
      return {
        ...settings,
        machineId: current,
      };
    }

    return {
      ...settings,
      lastTokenSubByServerId: nextLastSubByServerId,
      machineIdConfirmedByServerByServerId: nextConfirmed,
      // derived (not persisted in v5+)
      machineId: current,
    };
  }

  const previousAccountId = typeof nextLastSubByServerId[serverId] === 'string'
    ? String(nextLastSubByServerId[serverId]).trim()
    : '';

  const nextMachineIdByServerIdByAccountId = { ...(settings.machineIdByServerIdByAccountId ?? {}) };
  const scopedPerAccount = nextMachineIdByServerIdByAccountId[serverId];
  const currentPerAccount = { ...(scopedPerAccount ?? {}) };
  const hasPerAccountHistory = Boolean(scopedPerAccount && typeof scopedPerAccount === 'object');
  const perAccountMachineId = typeof currentPerAccount[accountId] === 'string' ? String(currentPerAccount[accountId]).trim() : '';

  const didAccountSwap = Boolean(previousAccountId && previousAccountId !== accountId);

  let machineId: string | null = null;
  if (!forceNew && (hasPerAccountHistory || !didAccountSwap)) {
    // Per-account history is authoritative even when opaque setup cleared the
    // last subject. Aggregate identity can backfill only an older history-free
    // scope whose recorded account has not changed.
    machineId = resolveMachineIdForServerFromSettings({
      machineIdByServerId: { ...nextMachineIdByServerId, [serverId]: prevMachineIdForServer ?? undefined },
      machineIdByServerIdByAccountId: nextMachineIdByServerIdByAccountId,
    }, serverId, accountId);
  }

  if (!machineId) {
    machineId = params.createMachineId();
  }

  const normalizedPrevMachineId = typeof prevMachineIdForServer === 'string' && prevMachineIdForServer.trim()
    ? prevMachineIdForServer.trim()
    : null;
  const needsServerMachineIdUpdate = normalizedPrevMachineId !== machineId;
  const needsLastSubUpdate = previousAccountId !== accountId;
  const needsPerAccountUpdate = machineId !== null && perAccountMachineId !== machineId;

  const needsConfirmedUpdate = (needsServerMachineIdUpdate || needsLastSubUpdate) && serverId in nextConfirmed;

  if (!needsServerMachineIdUpdate && !needsLastSubUpdate && !needsPerAccountUpdate && !needsConfirmedUpdate) {
    return { ...settings, machineId: machineId ?? undefined };
  }

  if (machineId) nextMachineIdByServerId[serverId] = machineId;
  else delete nextMachineIdByServerId[serverId];
  nextLastSubByServerId[serverId] = accountId;
  if (machineId) {
    currentPerAccount[accountId] = machineId;
    nextMachineIdByServerIdByAccountId[serverId] = currentPerAccount;
  }

  if (needsConfirmedUpdate) delete nextConfirmed[serverId];

  return {
    ...settings,
    machineIdByServerId: nextMachineIdByServerId,
    lastTokenSubByServerId: nextLastSubByServerId,
    machineIdByServerIdByAccountId: nextMachineIdByServerIdByAccountId,
    machineIdConfirmedByServerByServerId: nextConfirmed,
    // derived (not persisted in v5+)
    machineId: machineId ?? undefined,
  };
}
