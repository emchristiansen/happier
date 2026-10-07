import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * `move`: reconcile once. `always`: reconcile and remember the choice on this device (relay moves
 * only). `connectToo`: give the app's relay its own background service and leave this computer's
 * other daemon where it is (one daemon per relay; offered only through `offerConnectToo`). `keep`:
 * leave the background service where it is — remembered on this device (D5).
 */
export type RelayReconciliationConsentAnswer = 'move' | 'always' | 'connectToo' | 'keep';

/**
 * What the app is about to do to this computer's background service, named the way a person reads
 * it. The two moves are different questions: a relay move keeps the account, an account move takes
 * this computer away from the account it is signed in as (D1).
 */
export type ThisComputerMoveRequest =
    | Readonly<{
        kind: 'relay';
        fromRelayHost: string | null;
        toRelayHost: string;
        /** Offer "Connect to {toRelayHost} too" (`thisComputerCanConnectToo`). */
        offerConnectToo?: true;
    }>
    | Readonly<{
        kind: 'account';
        fromAccountLabel: string;
        toAccountLabel: string;
        /** The relay the app is on, where this computer will answer for `toAccountLabel`. */
        relayHost: string;
        /** Set only when the daemon is signed in on ANOTHER relay than `relayHost`. */
        fromRelayHost: string | null;
        /** Offer "Connect to {relayHost} too": the other relay's account keeps this computer. */
        offerConnectToo?: true;
    }>;

/**
 * UD5/D1's one ask. A relay move offers "Always move it" — the device-local preference for the
 * app's own default-following service. An account move never does: it always asks, and it says
 * which account loses this computer.
 *
 * The executor's service-ownership consent (pinned, manual, foreign-home, conflicting or multiple
 * services) is raised by the CLI through `presentSetupServiceConsent` and is never suppressed here.
 */
export async function presentRelayReconciliationConsent(request: ThisComputerMoveRequest): Promise<RelayReconciliationConsentAnswer> {
    let answer: RelayReconciliationConsentAnswer = 'keep';
    const keep = { text: t('setupSurface.relayMoveKeep'), style: 'cancel' as const, onPress: () => { answer = 'keep'; } };
    // The move stays the primary (last) action; "too" sits beside it, never in its place.
    const connectToo = request.offerConnectToo
        ? [{
            text: t('setupSurface.relayConnectToo', { relay: request.kind === 'account' ? request.relayHost : request.toRelayHost }),
            onPress: () => { answer = 'connectToo'; },
        }]
        : [];
    if (request.kind === 'account') {
        await Modal.alertAsync(
            t('setupSurface.accountMoveTitle', { account: request.toAccountLabel }),
            request.fromRelayHost
                ? t('setupSurface.accountMoveBodyAcrossRelays', {
                    from: request.fromAccountLabel,
                    fromRelay: request.fromRelayHost,
                    to: request.toAccountLabel,
                    toRelay: request.relayHost,
                })
                : t('setupSurface.accountMoveBody', {
                    from: request.fromAccountLabel,
                    to: request.toAccountLabel,
                    relay: request.relayHost,
                }),
            [
                keep,
                ...connectToo,
                { text: t('setupSurface.accountMoveConfirm'), onPress: () => { answer = 'move'; } },
            ],
        );
        return answer;
    }
    await Modal.alertAsync(
        t('setupSurface.relayMoveTitle'),
        request.fromRelayHost
            ? t('setupSurface.relayMoveBodyFromTo', { from: request.fromRelayHost, to: request.toRelayHost })
            : t('setupSurface.relayMoveBody', { relay: request.toRelayHost }),
        [
            keep,
            ...connectToo,
            { text: t('setupSurface.relayMoveAlways'), onPress: () => { answer = 'always'; } },
            { text: t('setupSurface.relayMoveConfirm'), onPress: () => { answer = 'move'; } },
        ],
    );
    return answer;
}
