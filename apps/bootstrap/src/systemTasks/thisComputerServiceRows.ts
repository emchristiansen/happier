import {
  comparableKeyOrNull,
  daemonStatusServesRelay,
  pinnedServiceServesRelay,
  readDaemonServiceStartFailure,
  type DaemonStatusSnapshot,
} from './localDaemonCli.js';
import { resolveServingThisComputerService } from '@happier-dev/cli-common/service';

/**
 * How one of this computer's background services stands for its relay, judged against the account
 * that relay itself validated (the only account known without an app): `offline` — no daemon
 * answers; `connected` — it answers, is signed in with a machine, and its service runs it converged;
 * `needs_attention` — it answers but something is off.
 */
export type ThisComputerServiceState = 'connected' | 'offline' | 'needs_attention';

/** What the app may do to a service from a row: only to one it manages (H2). */
export type ThisComputerServiceAction = 'start' | 'restart' | 'stop';

export type ThisComputerServiceRow = Readonly<{
  relayUrl: string;
  state: ThisComputerServiceState;
  /** R15 — the default-following service, or a pinned one the desktop created (`managedBy: desktop`). */
  appManaged: boolean;
  /** D11-2 — the service selected by bootstrap for this relay. */
  serving: 'default-following' | 'pinned';
  actions: readonly ThisComputerServiceAction[];
}>;

type ServiceFacts = Pick<DaemonStatusSnapshot, 'server' | 'auth' | 'service' | 'runtimeConvergence'>;

function resolveServiceState(facts: ServiceFacts): ThisComputerServiceState {
  const convergence = facts.runtimeConvergence;
  if (!convergence?.controlReachable) {
    return 'offline';
  }
  const converged = facts.auth.credentialState === 'valid'
    && facts.auth.validatedAccountId !== null
    && facts.auth.machineId !== null
    && facts.service.installed
    && convergence.serviceOwnsRunningDaemon
    && convergence.machineIdMatches
    && convergence.cliVersionMatches;
  return converged ? 'connected' : 'needs_attention';
}

function resolveActions(state: ThisComputerServiceState, appManaged: boolean, facts: ServiceFacts): readonly ThisComputerServiceAction[] {
  if (!appManaged || !facts.service.installed) return [];
  const startable = readDaemonServiceStartFailure(facts) === null;
  if (state === 'offline') return startable ? ['start'] : [];
  return startable ? ['restart', 'stop'] : ['stop'];
}

/**
 * R16 — THE list of this computer's background services, one row per relay: the default-following
 * service when one exists here (installed, or a daemon answering control), then each installed
 * pinned service. The status task reports it so every surface renders the same rows: the web UI
 * (which re-judges only the app's own relay against the app's account) and the native tray in
 * menu-bar mode, which renders them as they are.
 */
export function listThisComputerServiceRows(params: Readonly<{
  defaultFollowing: ServiceFacts;
  /** Without a listed inventory, an unknown pin may own the relay's actions. */
  listed: boolean;
  /** Facts for pinned definitions the CLI's inventory listed as installed. */
  pinned: readonly (ServiceFacts & Readonly<{ managedBy: 'desktop' | null }>)[];
  unreadableRelayUrls?: readonly string[];
}>): readonly ThisComputerServiceRow[] {
  const rows: ThisComputerServiceRow[] = [];
  const defaultFacts = params.defaultFollowing;
  const defaultCandidate = { facts: defaultFacts, appManaged: true };
  const pinned = [
    ...params.pinned.flatMap((facts) => facts.server.serverUrl ? [{ relayUrl: facts.server.serverUrl, value: { facts, appManaged: facts.managedBy === 'desktop' } }] : []),
    ...(params.unreadableRelayUrls ?? []).map((relayUrl) => ({ relayUrl, value: null })),
  ];
  const seen = new Set<string>();
  for (const relayUrl of [defaultFacts.server.serverUrl, ...pinned.map((item) => item.relayUrl)]) {
    if (!relayUrl) continue;
    const key = comparableKeyOrNull(relayUrl);
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    const selected = resolveServingThisComputerService({
      defaultFollowing: {
        eligible: daemonStatusServesRelay(defaultFacts, relayUrl),
        value: defaultCandidate,
      },
      pinned: pinned.map((item) => ({ eligible: pinnedServiceServesRelay(item, relayUrl), value: item.value })),
    });
    if (!selected?.value) continue;
    const { facts, appManaged } = selected.value;
    const state = resolveServiceState(facts);
    rows.push({ relayUrl: facts.server.serverUrl ?? relayUrl, state, appManaged, serving: selected.serving, actions: params.listed ? resolveActions(state, appManaged, facts) : [] });
  }
  return rows;
}
