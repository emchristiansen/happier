import type { AppVariant } from '@/sync/runtime/appVariant';

type HappierCliInstallChannel = 'stable' | 'preview' | 'dev';

function toOptionalNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim().toLowerCase();
    return trimmed.length > 0 ? trimmed : null;
}

function resolveInstallChannel(input: Readonly<{
    appVariant: AppVariant;
    distTagOverride?: unknown;
    channelOverride?: HappierCliInstallChannel;
}>): HappierCliInstallChannel {
    if (input.channelOverride) return input.channelOverride;
    const override = input.distTagOverride === undefined ? undefined : toOptionalNonEmptyString(input.distTagOverride);
    if (override === 'next' || override === 'preview') return 'preview';
    if (input.appVariant === 'production') return 'stable';
    return 'preview';
}

export function buildHappierCliCommandName(input: Readonly<{
    appVariant: AppVariant;
    distTagOverride?: unknown;
    channelOverride?: HappierCliInstallChannel;
}>): 'happier' | 'hprev' | 'hdev' {
    const channel = resolveInstallChannel(input);
    if (channel === 'dev') return 'hdev';
    return channel === 'preview' ? 'hprev' : 'happier';
}

export function buildHappierCliInstallCommand(input: Readonly<{
    appVariant: AppVariant;
    distTagOverride?: unknown;
    channelOverride?: HappierCliInstallChannel;
    suppressAutomaticSetup?: boolean;
}>): string {
    const channel = resolveInstallChannel(input);
    if (channel === 'dev') {
        return `curl -fsSL https://happier.dev/install | bash -s -- --channel dev${input.suppressAutomaticSetup ? ' --yes' : ''}`;
    }
    if (channel === 'preview') {
        return `curl -fsSL https://happier.dev/install | bash -s -- --channel preview${input.suppressAutomaticSetup ? ' --yes' : ''}`;
    }
    return input.suppressAutomaticSetup
        ? 'curl -fsSL https://happier.dev/install | bash -s -- --yes'
        : 'curl -fsSL https://happier.dev/install | bash';
}
