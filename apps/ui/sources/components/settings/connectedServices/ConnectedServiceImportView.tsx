import * as React from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ConnectedServiceIdSchema, ConnectedServiceProfileIdSchema, type ConnectedServiceImportSourceV1 } from '@happier-dev/protocol';

import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useActiveServerAccountScope, useAllMachines } from '@/sync/store/hooks';
import { sync } from '@/sync/sync';
import { getMachineDisplayName, isMachineOnline } from '@/utils/sessions/machineUtils';
import { importConnectedServiceLogin } from '@/sync/ops/connectedServices/importConnectedServiceLogin';
import { invalidateConnectedServiceGroupsRefreshSignal } from '@/sync/domains/connectedServices/connectedServiceGroupsRefreshSignal';
import { fireAndForget } from '@/utils/system/fireAndForget';

function routeValue(value: unknown): string {
    return typeof value === 'string' ? value : Array.isArray(value) ? routeValue(value[0]) : '';
}

type SourceDiscovery = Readonly<{
    machineId: string;
    serverId: string;
    accountId: string;
    sources: readonly ConnectedServiceImportSourceV1[];
    status: 'loading' | 'ready' | 'unavailable' | 'failed';
}>;

export function ConnectedServiceImportView() {
    const params = useLocalSearchParams();
    const router = useRouter();
    const enabled = useFeatureEnabled('connectedServices');
    const scope = useActiveServerAccountScope();
    const machines = useAllMachines();
    const service = ConnectedServiceIdSchema.safeParse(routeValue(params.serviceId));
    const profile = ConnectedServiceProfileIdSchema.safeParse(routeValue(params.profileId));
    const serviceId = service.success ? service.data : null;
    const profileId = profile.success ? profile.data : null;
    const [machineId, setMachineId] = React.useState('');
    const [machineMenuOpen, setMachineMenuOpen] = React.useState(false);
    const [source, setSource] = React.useState('');
    const [discovery, setDiscovery] = React.useState<SourceDiscovery | null>(null);
    const [retry, setRetry] = React.useState(0);
    const [busy, setBusy] = React.useState(false);
    const [outcomeUnknown, setOutcomeUnknown] = React.useState(false);
    const locked = busy || outcomeUnknown;
    const selectedMachine = machines.find((machine) => machine.id === machineId);
    const online = Boolean(selectedMachine && isMachineOnline(selectedMachine));
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;

    React.useEffect(() => {
        if (!enabled || !serviceId || !serverId || !accountId || !machineId || !online) return;
        let active = true;
        setSource('');
        setDiscovery({ machineId, serverId, accountId, sources: [], status: 'loading' });
        void importConnectedServiceLogin({ machineId, serverId, accountId, request: { op: 'discover', serviceId } }).then((result) => {
            if (!active) return;
            if (result.ok && result.op === 'discover') {
                setDiscovery({ machineId, serverId, accountId, sources: result.sources, status: result.sources.length ? 'ready' : 'unavailable' });
                setSource(result.sources[0]?.id ?? '');
            } else {
                const unavailable = !result.ok && ['unsupported', 'unsupported_source', 'connected_service_unsupported'].includes(result.errorCode);
                setDiscovery({ machineId, serverId, accountId, sources: [], status: unavailable ? 'unavailable' : 'failed' });
            }
        });
        return () => { active = false; };
    }, [enabled, serviceId, serverId, accountId, machineId, online, retry]);

    const current = discovery?.machineId === machineId && discovery.serverId === serverId && discovery.accountId === accountId && online ? discovery : null;
    const canImport = Boolean(!outcomeUnknown && enabled && scope && profileId && current?.status === 'ready' && current.sources.some((item) => item.id === source));
    const submit = async () => {
        if (!canImport || busy || !serviceId || !profileId || !serverId || !accountId) return;
        setBusy(true);
        try {
            const result = await importConnectedServiceLogin({ machineId, serverId, accountId, request: { op: 'import', serviceId, profileId, source } });
            if (!result.ok) {
                if (result.errorCode === 'storage_result_unknown') setOutcomeUnknown(true);
                const message = result.errorCode === 'storage_result_unknown'
                    ? t('connectedServices.importAccounts.unknownResult')
                    : result.errorCode === 'credentials_unavailable' || result.errorCode === 'unsupported_source'
                    ? t('connectedServices.importAccounts.credentialsUnavailable')
                    : result.errorCode === 'connected_service_unsupported'
                        ? t('connectedServices.detail.errors.serviceUnsupportedServer')
                    : result.errorCode === 'unsupported'
                        ? t('connectedServices.importAccounts.unsupported')
                        : result.errorCode === 'profile_conflict' || result.errorCode === 'credential_superseded'
                            ? t('connectedServices.importAccounts.profileConflict')
                            : result.errorCode === 'reauthorization_required'
                                ? t('connectedServices.importAccounts.reauthorizationRequired')
                                : t('connectedServices.importAccounts.failed');
                await Modal.alert(t('common.error'), message);
                return;
            }
            invalidateConnectedServiceGroupsRefreshSignal();
            try {
                await sync.refreshProfile();
            } catch {
                await Modal.alert(t('connectedServices.importAccounts.imported'), t('connectedServices.importAccounts.refreshFailed'));
            }
            router.back();
        } finally {
            setBusy(false);
        }
    };
    const refreshUnknownResult = async () => {
        if (busy || !outcomeUnknown) return;
        setBusy(true);
        try {
            invalidateConnectedServiceGroupsRefreshSignal();
            await sync.refreshProfile();
            router.back();
        } catch {
            await Modal.alert(t('common.error'), t('connectedServices.importAccounts.unknownResult'));
        } finally {
            setBusy(false);
        }
    };

    if (!enabled || !serviceId || !profileId || !scope) {
        return <ItemList><ItemGroup><Item title={t('connectedServices.oauthPaste.invalidConfig')} showChevron={false} /></ItemGroup></ItemList>;
    }

    return (
        <ItemList>
            <ItemGroup title={t('connectedServices.importAccounts.title')} footer={t('connectedServices.importAccounts.description')}>
                <DropdownMenu
                    open={machineMenuOpen} onOpenChange={setMachineMenuOpen} selectedId={machineId}
                    items={machines.map((machine) => ({ id: machine.id, title: getMachineDisplayName(machine) ?? machine.id, disabled: locked || !isMachineOnline(machine) }))}
                    onSelect={(id) => { if (!locked) { setMachineId(id); setMachineMenuOpen(false); } }}
                    itemTrigger={{ title: t('newSession.selectMachineTitle'), subtitle: selectedMachine ? getMachineDisplayName(selectedMachine) ?? machineId : t('newSession.noMachineSelected'), itemProps: { disabled: locked } }}
                />
                {current?.status === 'loading' ? <Item title={t('common.loading')} showChevron={false} /> : null}
                {current?.status === 'unavailable' ? <Item title={t('connectedServices.importAccounts.unsupported')} subtitle={t('common.retry')} onPress={() => setRetry((value) => value + 1)} /> : null}
                {current?.status === 'failed' ? <Item title={t('connectedServices.importAccounts.failed')} subtitle={t('common.retry')} onPress={() => setRetry((value) => value + 1)} /> : null}
                {current?.sources.map((item) => <Item key={item.id} testID={`connectedServices.import.source:${item.id}`} title={item.label}
                    accessibilityRole="radio" accessibilityState={{ checked: source === item.id, disabled: locked }}
                    selected={source === item.id} disabled={locked} onPress={() => { if (!locked) setSource(item.id); }} showChevron={false} />)}
            </ItemGroup>
            <ItemGroup>
                <Item testID="connectedServices.import.submit" title={busy ? t('common.loading') : t('connectedServices.importAccounts.title')}
                    subtitle={profileId} disabled={!canImport || busy} showChevron={false}
                    onPress={() => fireAndForget(submit(), { tag: 'ConnectedServiceImportView.submit' })} />
                {outcomeUnknown ? <Item testID="connectedServices.import.refresh" title={t('common.refresh')}
                    subtitle={t('connectedServices.importAccounts.unknownResult')} subtitleLines={0} disabled={busy} showChevron={false}
                    onPress={() => fireAndForget(refreshUnknownResult(), { tag: 'ConnectedServiceImportView.refreshUnknownResult' })} /> : null}
            </ItemGroup>
        </ItemList>
    );
}
