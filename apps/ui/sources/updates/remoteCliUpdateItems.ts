import type { MachineCapabilitiesSnapshot } from '@/hooks/server/useMachineCapabilitiesCache';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { getMachineDisplayName, isMachineOnline } from '@/utils/sessions/machineUtils';

import { buildRemoteCliUpdateItem } from './items/buildMachineUpdateItems';
import type { UpdateItem } from './items/updateItem';
import { readRemoteCliUpdateAdvertised } from './machineCapabilitySnapshots';
import { observeMachineUpdateRun, signatureOfLastUpdate } from './machineUpdateRuns';
import type { useMachineUpdateRuns } from './machineUpdateRuns';

export type RemoteMachineUpdateFacts = Readonly<{
    machine: Machine;
    name: string;
    online: boolean;
    cliItem: UpdateItem;
    lastUpdateSignature: string;
}>;

/**
 * Every other machine's Happier CLI row, from machine metadata alone (K5 `cliUpdate`, else the
 * `happyCliVersion` every released daemon writes) — no RPC, so the always-mounted summary and the
 * open surface both use it. Remote Update is offered only when the machine says it can update itself
 * (`canUpdateRemotely`) AND its daemon lists `cli.update.v1` among its `tool.systemTasks` kinds.
 */
export function buildRemoteMachineUpdateFacts(
    machines: readonly Machine[],
    thisMachineId: string | null,
    runs: ReturnType<typeof useMachineUpdateRuns>,
    /** Cached capability detects (never fetched here) — the `tool.systemTasks` kinds live there. */
    snapshots: ReadonlyMap<string, MachineCapabilitiesSnapshot | null>,
): RemoteMachineUpdateFacts[] {
    const result: RemoteMachineUpdateFacts[] = [];
    for (const machine of machines) {
        if (machine.id === thisMachineId || !machine.metadata) continue;
        const facts = machine.metadata.cliUpdate ?? null;
        const online = isMachineOnline(machine);
        const lastUpdateSignature = signatureOfLastUpdate(facts?.lastUpdate ?? null);
        const cliItem = buildRemoteCliUpdateItem({
            machineId: machine.id,
            title: t('updates.happierCliTitle'),
            online,
            platform: machine.metadata.platform ?? null,
            happyCliVersion: machine.metadata.happyCliVersion || null,
            facts,
            // K5: the machine's own fact, and the daemon's kinds once a detect has been cached
            // (`null` = not read yet; a daemon with K5 facts lists the kind exactly when it can).
            remoteUpdateAdvertised: facts?.canUpdateRemotely === true
                ? readRemoteCliUpdateAdvertised(snapshots.get(machine.id) ?? null)
                : false,
            task: observeMachineUpdateRun(runs, `${machine.id}:happier-cli`, { lastUpdateSignature }),
        });
        result.push({ machine, name: getMachineDisplayName(machine) ?? machine.id, online, cliItem, lastUpdateSignature });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
}
