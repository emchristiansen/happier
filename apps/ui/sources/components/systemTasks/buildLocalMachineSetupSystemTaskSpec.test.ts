import { describe, expect, it } from 'vitest';

import { buildLocalMachineSetupSystemTaskSpec } from './buildLocalMachineSetupSystemTaskSpec';

describe('buildLocalMachineSetupSystemTaskSpec', () => {
    it('sends the app-selected relay, account and ring explicitly and carries no step toggles', () => {
        const spec = buildLocalMachineSetupSystemTaskSpec({
            activeRelayUrl: 'https://relay.example.test',
            activeWebappUrl: 'https://app.example.test',
            activeLocalRelayUrl: null,
            channel: 'preview',
            expectedAccountId: 'acct_app',
        });

        expect(spec.kind).toBe('setup.thisComputer.v1');
        // The executor reads exactly these; the app's own server profile id is not one of them,
        // so the spec must not carry it.
        expect(Object.keys(spec.params as Record<string, unknown>).sort()).toEqual([
            'activeLocalRelayUrl',
            'activeRelayUrl',
            'activeWebappUrl',
            'channel',
            'expectedAccountId',
            'surface',
        ]);
        expect(spec.params).toEqual({
            activeRelayUrl: 'https://relay.example.test',
            activeWebappUrl: 'https://app.example.test',
            activeLocalRelayUrl: null,
            channel: 'preview',
            expectedAccountId: 'acct_app',
            surface: 'desktop.ui',
        });
    });

    it('maps the app variant to the executor channel', () => {
        expect(buildLocalMachineSetupSystemTaskSpec({
            activeRelayUrl: 'https://relay.example.test',
            activeWebappUrl: 'https://app.example.test',
            activeLocalRelayUrl: 'http://127.0.0.1:3005',
            channel: 'stable',
            expectedAccountId: 'acct_app',
        }).params).toMatchObject({ channel: 'stable', activeLocalRelayUrl: 'http://127.0.0.1:3005' });
    });
});
