import * as React from 'react';
import { Animated, Platform, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useAuth } from '@/auth/context/AuthContext';
import { UnauthenticatedSplitShell } from '@/components/onboarding/unauthShell';
import { DesktopOnlySetupNotice } from '@/components/settings/machines/DesktopOnlySetupNotice';
import { MachineSetupFlowScreen } from '@/components/settings/machines/MachineSetupFlowScreen';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { MachineSetupTextField } from '@/components/settings/machines/shared/MachineSetupTextField';
import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { selectRelayDirectly } from '@/setup/directRelaySelectionIntent';
import { clearPendingSetupIntent, setPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { usePendingSetupIntent } from '@/components/onboarding/state/usePendingSetupIntent';
import {
    listServerProfiles,
    resolveServerProfileScopeId,
    upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { validateServerUrl } from '@/sync/domains/server/serverConfig';
import { t } from '@/text';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { Icon } from '@/components/ui/icons/Icon';
import { fireAndForget } from '@/utils/system/fireAndForget';

const ignoreBrandHeroGetStarted = () => undefined;

function normalizeRelayUrl(rawUrl: string | null | undefined): string | null {
    const value = String(rawUrl ?? '').trim().replace(/\/+$/, '');
    return value ? value : null;
}

function readOpenCustomParam(value: string | string[] | undefined): boolean {
    const rawValue = Array.isArray(value) ? value[0] : value;
    return String(rawValue ?? '').trim() === '1';
}

const styles = StyleSheet.create((theme) => ({
    routeContentRoot: {
        flex: 1,
        ...(Platform.OS === 'web' ? { minHeight: 0 } : {}),
    },
    errorInput: {
        borderColor: theme.colors.state.danger.foreground,
    },
    errorFooterText: {
        color: theme.colors.state.danger.foreground,
    },
    inlineFormContent: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 16,
    },
}));

function InlineRelayFormRows(props: Readonly<{
    customRelayError: string | null;
    customRelayName: string;
    customRelayUrl: string;
    onCustomRelayNameChange: (value: string) => void;
    onCustomRelayUrlChange: (value: string) => void;
    relayFormOpacity: Animated.Value;
    showDivider?: boolean;
}>): React.ReactElement {
    return (
        <Animated.View
            testID="setup.customRelayForm"
            style={{ opacity: props.relayFormOpacity }}
        >
            <View style={styles.inlineFormContent}>
                <MachineSetupTextField
                    testID="setup.customRelayUrl"
                    label={t('setupOnboarding.customRelayUrlLabel')}
                    value={props.customRelayUrl}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    placeholder={t('common.urlPlaceholder')}
                    inputStyle={props.customRelayError ? styles.errorInput : undefined}
                    onChangeText={props.onCustomRelayUrlChange}
                />
                <MachineSetupTextField
                    testID="setup.customRelayName"
                    label={t('setupOnboarding.relayNameLabel')}
                    value={props.customRelayName}
                    autoCorrect={false}
                    onChangeText={props.onCustomRelayNameChange}
                />
            </View>
        </Animated.View>
    );
}

function BrowserWebSetupRoute(props: Readonly<{ useUnauthenticatedChrome: boolean }>) {
    const snapshot = React.useSyncExternalStore(subscribeActiveServer, getActiveServerSnapshot, getActiveServerSnapshot);
    const relayUrl = normalizeRelayUrl(snapshot.serverUrl ?? null);

    React.useEffect(() => {
        clearPendingSetupIntent();
    }, []);

    const content = (
        <View testID="relay-select-route-content" style={styles.routeContentRoot}>
            <ItemList>
                <DesktopOnlySetupNotice
                    testID="setup.desktopOnlyNotice"
                    groupTitle={t('setupOnboarding.controlPanelTitle')}
                    title={t('setupOnboarding.webDesktopOnlyTitle')}
                    subtitle={t('setupOnboarding.webDesktopOnlyBody')}
                />
                <ItemGroup title={t('setupOnboarding.currentRelayTitle')}>
                    <Item
                        testID="setup.web.activeRelay"
                        title={t('setupOnboarding.activeRelaySummaryTitle')}
                        subtitle={relayUrl ? toServerUrlDisplay(relayUrl) : t('status.unknown')}
                        showChevron={false}
                        mode="info"
                    />
                </ItemGroup>
            </ItemList>
        </View>
    );

    if (!props.useUnauthenticatedChrome) {
        return content;
    }

    return (
        <UnauthenticatedSplitShell
            stepId="setup-browser-web"
            isWelcomeStep={false}
            allowMobileBrandHero={false}
            onOpenRelayCustomFlow={() => router.push('/setup')}
            onBrandHeroGetStarted={ignoreBrandHeroGetStarted}
            onBack={() => router.back()}
            testID="unauth-shell-route-setup-browser-web"
        >
            {content}
        </UnauthenticatedSplitShell>
    );
}

function PreAuthSetupRoute() {
    const { theme } = useUnistyles();
    const params = useLocalSearchParams<{ openCustom?: string | string[] }>();
    const snapshot = React.useSyncExternalStore(subscribeActiveServer, getActiveServerSnapshot, getActiveServerSnapshot);
    const relayUrl = normalizeRelayUrl(snapshot.serverUrl ?? null);
    const savedRelayProfiles = React.useMemo(() => listServerProfiles()
        .slice()
        .filter((profile) => {
            const profileRelayUrl = normalizeRelayUrl(profile.serverUrl);
            return resolveServerProfileScopeId(profile) !== snapshot.serverId && profileRelayUrl !== relayUrl;
        }), [relayUrl, snapshot.generation, snapshot.serverId]);
    const shouldOpenCustomRelayForm = readOpenCustomParam(params.openCustom);
    const [showInlineRelayForm, setShowInlineRelayForm] = React.useState(shouldOpenCustomRelayForm);
    const [customRelayUrl, setCustomRelayUrl] = React.useState('');
    const [customRelayName, setCustomRelayName] = React.useState('');
    const [customRelayError, setCustomRelayError] = React.useState<string | null>(null);
    const relayFormOpacity = React.useRef(new Animated.Value(0)).current;
    const [, setServerSelectionActiveTargetKind] = useSettingMutable('serverSelectionActiveTargetKind');
    const [, setServerSelectionActiveTargetId] = useSettingMutable('serverSelectionActiveTargetId');
    /**
     * R8/INV7 — a relay picked or added here is the person choosing it for this device, so it goes
     * through the one direct-selection operation: after sign-in the desktop setup gate may then
     * offer to move this computer's background service there. `refreshAuth` is null because the
     * auth provider already refreshes on every active-server change, and onboarding reaches sign-in
     * through its own Continue path.
     */
    const selectRelay = React.useCallback(async (serverId: string) => {
        await selectRelayDirectly({
            serverId,
            selectionTarget: { setServerSelectionActiveTargetKind, setServerSelectionActiveTargetId },
            refreshAuth: null,
        });
    }, [setServerSelectionActiveTargetId, setServerSelectionActiveTargetKind]);
    const continueToAuthForRelay = React.useCallback((nextRelayUrl: string | null) => {
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: nextRelayUrl,
        });
        router.replace('/');
    }, []);

    const handleContinueToAuth = React.useCallback(async () => {
        continueToAuthForRelay(normalizeRelayUrl(getActiveServerSnapshot().serverUrl ?? relayUrl));
    }, [continueToAuthForRelay, relayUrl]);

    const handleDiscard = React.useCallback(() => {
        // Discarding means there is no intent, not an intent in a "dismissed" state: no reader
        // ever told the two apart, and the marker only kept a record alive for a day for nothing.
        clearPendingSetupIntent();
        router.replace('/');
    }, []);

    const handleAddRelay = React.useCallback(async () => {
        const nextRelayUrl = normalizeRelayUrl(customRelayUrl);
        const validation = validateServerUrl(nextRelayUrl ?? customRelayUrl);
        if (!nextRelayUrl || !validation.valid) {
            setCustomRelayError(t('errors.invalidFormat'));
            return;
        }

        const profile = upsertServerProfile({
            serverUrl: nextRelayUrl,
            ...(customRelayName.trim() ? { name: customRelayName.trim() } : {}),
            source: 'manual',
            replaceEquivalentStoredUrl: true,
        });
        await selectRelay(resolveServerProfileScopeId(profile));
        setCustomRelayUrl('');
        setCustomRelayName('');
        setCustomRelayError(null);
        setShowInlineRelayForm(false);
        continueToAuthForRelay(nextRelayUrl);
    }, [continueToAuthForRelay, customRelayName, customRelayUrl, selectRelay]);

    React.useEffect(() => {
        if (shouldOpenCustomRelayForm) {
            setShowInlineRelayForm(true);
        }
    }, [shouldOpenCustomRelayForm]);

    React.useEffect(() => {
        if (!showInlineRelayForm) {
            relayFormOpacity.setValue(0);
            return;
        }
        Animated.timing(relayFormOpacity, {
            toValue: 1,
            duration: motionTokens.durationMs.base,
            easing: motionTokens.easing.standard,
            useNativeDriver: true,
        }).start();
    }, [relayFormOpacity, showInlineRelayForm]);

    return (
        <UnauthenticatedSplitShell
            stepId="setup-pre-auth"
            isWelcomeStep={false}
            allowMobileBrandHero={false}
            onOpenRelayCustomFlow={() => router.push('/setup')}
            onBrandHeroGetStarted={ignoreBrandHeroGetStarted}
            onBack={() => router.back()}
            testID="unauth-shell-route-setup-pre-auth"
        >
            <View testID="relay-select-route-content" style={styles.routeContentRoot}>
                <ItemList>
                    <ItemGroup title={t('setupOnboarding.currentRelayTitle')}>
                        <Item
                            testID="setup.currentRelay"
                            title={t('setupOnboarding.currentRelayTitle')}
                            subtitle={t('setupOnboarding.currentRelayDescription', {
                                relayUrl: relayUrl ?? t('status.unknown'),
                            })}
                            showChevron={false}
                            mode="info"
                        />
                    </ItemGroup>

                    {savedRelayProfiles.length > 0 ? (
                        <ItemGroup title={t('setupOnboarding.savedRelaysTitle')}>
                            {savedRelayProfiles.map((profile) => (
                                <Item
                                    key={profile.id}
                                    testID={`setup.savedRelay.${profile.id}`}
                                    title={profile.name}
                                    subtitle={toServerUrlDisplay(profile.serverUrl)}
                                    selected={resolveServerProfileScopeId(profile) === snapshot.serverId}
                                    showChevron={false}
                                    onPress={() => {
                                        fireAndForget(selectRelay(resolveServerProfileScopeId(profile)), { tag: 'setup.selectSavedRelay' });
                                    }}
                                />
                            ))}
                        </ItemGroup>
                    ) : null}

                    <ItemGroup title={t('common.actions')}>
                        <Item
                            testID="setup.continueToAuth"
                            title={t('setupOnboarding.continueToAuth')}
                            onPress={() => {
                                void handleContinueToAuth();
                            }}
                        />
                    </ItemGroup>

                    <ItemGroup
                        footer={customRelayError ?? undefined}
                        footerTextStyle={customRelayError ? styles.errorFooterText : undefined}
                    >
                        <Item
                            testID="setup.changeRelay"
                            title={t('setupOnboarding.changeRelayAction')}
                            onPress={() => {
                                setShowInlineRelayForm((current) => !current);
                            }}
                            showChevron={false}
                            rightElement={(
                                <Icon
                                    name={showInlineRelayForm ? 'caret-down' : 'caret-right'}
                                    size={20}
                                    color={theme.colors.text.secondary}
                                />
                            )}
                        />
                        {showInlineRelayForm ? (
                            <>
                                <InlineRelayFormRows
                                    showDivider={false}
                                    customRelayError={customRelayError}
                                    customRelayUrl={customRelayUrl}
                                    customRelayName={customRelayName}
                                    relayFormOpacity={relayFormOpacity}
                                    onCustomRelayUrlChange={(value) => {
                                        setCustomRelayUrl(value);
                                        if (customRelayError) setCustomRelayError(null);
                                    }}
                                    onCustomRelayNameChange={setCustomRelayName}
                                />
                                <Item
                                    testID="setup.addRelay"
                                    title={t('setupOnboarding.addAndUseRelay')}
                                    disabled={!customRelayUrl.trim()}
                                    onPress={() => fireAndForget(handleAddRelay(), { tag: 'setup.addRelay' })}
                                />
                            </>
                        ) : null}
                    </ItemGroup>

                    <ItemGroup>
                        <Item
                            testID="setup.discard"
                            title={t('common.discard')}
                            onPress={handleDiscard}
                            destructive
                        />
                    </ItemGroup>
                </ItemList>
            </View>
        </UnauthenticatedSplitShell>
    );
}

function PostAuthSetupRoute() {
    const pending = usePendingSetupIntent();
    const desktop = isTauriDesktop();
    const livePending = pending?.phase === 'awaiting_auth' || pending?.phase === 'post_auth' ? pending : null;
    const remoteMachineContinuation = livePending?.branch === 'remoteMachine' ? livePending : null;
    /**
     * R9/INV1: after authentication exactly one owner performs "make this computer ready" — the
     * `DesktopLocalSetupRuntime` the authenticated desktop shell mounts, driven by
     * `desktopSetupCoordinator` and presented on the Home. This route must never be a second one,
     * so a desktop visit whose only business is local setup goes to the Home instead of rendering
     * another setup surface. The remote-machine
     * branch keeps its post-auth job here: resuming provider follow-up after a relay adoption
     * (`MachineSetupFlowScreen`'s switch-to-remote-relay action).
     */
    const shouldDeferToSetupGate = desktop && remoteMachineContinuation === null;
    const effectivePending = React.useMemo(() => {
        if (livePending?.phase !== 'awaiting_auth') {
            return livePending;
        }
        return {
            ...livePending,
            phase: 'post_auth',
        } as const;
    }, [livePending]);

    React.useEffect(() => {
        if (!shouldDeferToSetupGate) {
            return;
        }
        router.replace('/');
    }, [shouldDeferToSetupGate]);

    React.useEffect(() => {
        if (shouldDeferToSetupGate || pending?.phase !== 'awaiting_auth') {
            return;
        }
        setPendingSetupIntent({
            ...pending,
            phase: 'post_auth',
        });
    }, [pending, shouldDeferToSetupGate]);

    const handleDiscard = React.useCallback(() => {
        clearPendingSetupIntent();
        router.replace('/');
    }, []);

    if (shouldDeferToSetupGate) {
        return null;
    }

    return (
        <ItemList>
            {effectivePending ? (
                <ItemGroup title={t('setupOnboarding.postAuthTitle')}>
                    <Item
                        testID="setup.postAuth"
                        title={t('setupOnboarding.postAuthBody')}
                        showChevron={false}
                        mode="info"
                    />
                    <Item
                        testID="setup.postAuthDiscard"
                        title={t('common.discard')}
                        onPress={handleDiscard}
                    />
                </ItemGroup>
            ) : null}
            {desktop && remoteMachineContinuation ? (
                <MachineSetupFlowScreen
                    embedded
                    initialProviderMachineId={remoteMachineContinuation.machineId}
                    onLocalSetupSucceeded={() => {
                        clearPendingSetupIntent();
                    }}
                />
            ) : (
                <DesktopOnlySetupNotice
                    testID="setup.desktopOnlyNotice"
                    groupTitle={t('setupOnboarding.controlPanelTitle')}
                    title={t('setupOnboarding.webDesktopOnlyTitle')}
                    subtitle={t('setupOnboarding.webDesktopOnlyBody')}
                />
            )}
        </ItemList>
    );
}

export default function SetupRoute() {
    const auth = useAuth();
    const params = useLocalSearchParams<{ openCustom?: string | string[] }>();
    const shouldOpenCustomRelayForm = readOpenCustomParam(params.openCustom);
    const isBrowserWeb = Platform.OS === 'web' && !isTauriDesktop();
    if (isBrowserWeb && (!shouldOpenCustomRelayForm || auth.isAuthenticated)) {
        return <BrowserWebSetupRoute useUnauthenticatedChrome={!auth.isAuthenticated} />;
    }
    return auth.isAuthenticated ? <PostAuthSetupRoute /> : <PreAuthSetupRoute />;
}
