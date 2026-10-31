import type { SystemTaskRunState } from '@/components/systemTasks/types';
import type { RelayDriftClassification } from '@/sync/domains/server/relayDrift/relayDriftModel';

/**
 * U7 — what every surface describing this computer says about it, from the one classification.
 * One title, one sentence naming the relay host and account label, one action.
 */
export type RelayDriftSummary = Readonly<{
    status: Exclude<RelayDriftClassification['status'], 'aligned'>;
    title: string;
    description: string;
    actionLabel: string;
    /** The daemon's relay, when switching the APP to it is a meaningful alternative. */
    daemonRelayUrl: string | null;
}>;

export type RelayDriftBanner = Readonly<{
    kind: 'warning';
    title: string;
    description: string;
    actionLabel: string;
    secondaryActionLabel?: string;
    actionDisabled?: boolean;
    actionHint?: string;
    onPress: () => void | Promise<void>;
    onSecondaryPress?: () => void | Promise<void>;
    isRepairStarting: boolean;
    repairTaskSnapshot: SystemTaskRunState | null;
    onCancelRepair?: () => void;
}>;
