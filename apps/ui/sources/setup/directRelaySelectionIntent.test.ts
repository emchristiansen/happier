import { describe, expect, it } from 'vitest';

import {
    consumeDirectRelaySelectionIntent,
    readDirectRelaySelectionIntentGeneration,
    recordDirectRelaySelectionIntent,
    subscribeDirectRelaySelectionIntent,
} from './directRelaySelectionIntent';

/**
 * The fact is a single in-memory slot for this app run, so the cases below are written in an order
 * that establishes the state each one needs rather than relying on a reset hook that production
 * has no use for.
 */
describe('directRelaySelectionIntent (R8/INV7)', () => {
    it('answers no when nothing was chosen in this app run', () => {
        expect(consumeDirectRelaySelectionIntent('custom-3')).toBe(false);
    });

    it('is consumed exactly once by the relay the user chose, and never replayed', () => {
        recordDirectRelaySelectionIntent('custom-3');

        expect(consumeDirectRelaySelectionIntent('custom-3')).toBe(true);
        expect(consumeDirectRelaySelectionIntent('custom-3')).toBe(false);
    });

    it('answers no for a relay the user did not choose, and keeps the one they did', () => {
        recordDirectRelaySelectionIntent('custom-3');

        expect(consumeDirectRelaySelectionIntent('custom-9')).toBe(false);
        expect(consumeDirectRelaySelectionIntent('custom-3')).toBe(true);
    });

    it('keeps only the latest choice', () => {
        recordDirectRelaySelectionIntent('custom-3');
        recordDirectRelaySelectionIntent('custom-4');

        expect(consumeDirectRelaySelectionIntent('custom-3')).toBe(false);
        expect(consumeDirectRelaySelectionIntent('custom-4')).toBe(true);
    });

    it('ignores a blank identifier rather than arming an intent nothing named', () => {
        recordDirectRelaySelectionIntent('   ');

        expect(consumeDirectRelaySelectionIntent('')).toBe(false);
        expect(consumeDirectRelaySelectionIntent('   ')).toBe(false);
    });

    it('matches the two identifiers the app uses for one profile', async () => {
        // The direct action records the target id the picker offered, while the gate asks with the
        // active server id the runtime settled on. For an identity-backed profile those are
        // different strings for the same relay, so a plain string comparison would silently drop
        // every genuine direct selection.
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        try {
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const profile = profiles.upsertServerProfile({ serverUrl: 'https://identity.example.test', name: 'Identity' });
            profiles.setServerProfileIdentityForUrl(profile.serverUrl, 'srv_identity_active');

            recordDirectRelaySelectionIntent(profile.id);

            expect(consumeDirectRelaySelectionIntent('srv_identity_active')).toBe(true);
        } finally {
            if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        }
    });

    /**
     * F6 — a choice is only the reason for the NEXT relay change while the app is still on the relay
     * that was chosen. A pick that never became a relay change (a first-run onboarding pick, or a
     * pick of the relay the app was already on) must not survive the app leaving that relay, or an
     * ambient return later in the run would be spent as if the person had just chosen it.
     */
    it('keeps the choice through its own switch, and forgets it once the app moves to another relay (F6)', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        try {
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const chosen = profiles.upsertServerProfile({ serverUrl: 'https://chosen.example.test', name: 'Chosen' });
            const other = profiles.upsertServerProfile({ serverUrl: 'https://other.example.test', name: 'Other' });
            profiles.setActiveServerId(other.id, { scope: 'device' });

            // The direct pick records, then switches to the relay it chose: still the reason.
            recordDirectRelaySelectionIntent(chosen.id);
            profiles.setActiveServerId(chosen.id, { scope: 'device' });
            expect(consumeDirectRelaySelectionIntent(chosen.id)).toBe(true);

            // A pick that is never spent (nothing drifted), then an ambient move away and back.
            recordDirectRelaySelectionIntent(chosen.id);
            profiles.setActiveServerId(other.id, { scope: 'device' });
            profiles.setActiveServerId(chosen.id, { scope: 'device' });
            expect(consumeDirectRelaySelectionIntent(chosen.id)).toBe(false);
        } finally {
            if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        }
    });

    it('tells the gate a choice was made, even when the app is already on that relay (B1)', () => {
        // The counterexample: a notification moved the app to this relay, the gate refused to
        // repoint the daemon for it, and the user now picks the very same relay on purpose.
        // Nothing about the app's identity changes, so only the recording itself can say the
        // question was answered — otherwise the deliberate choice does nothing at all.
        const seen: number[] = [];
        const unsubscribe = subscribeDirectRelaySelectionIntent(() => seen.push(readDirectRelaySelectionIntentGeneration()));
        try {
            const before = readDirectRelaySelectionIntentGeneration();
            recordDirectRelaySelectionIntent('custom-3');
            const after = readDirectRelaySelectionIntentGeneration();

            expect(after).not.toBe(before);
            expect(seen).toEqual([after]);

            // Spending the intent is not a new choice: the generation holds still so the gate does
            // not treat its own consumption as another answer to act on.
            expect(consumeDirectRelaySelectionIntent('custom-3')).toBe(true);
            expect(readDirectRelaySelectionIntentGeneration()).toBe(after);
            expect(seen).toEqual([after]);
        } finally {
            unsubscribe();
        }

        recordDirectRelaySelectionIntent('custom-5');
        expect(seen).toHaveLength(1);
        expect(consumeDirectRelaySelectionIntent('custom-5')).toBe(true);
    });
});
