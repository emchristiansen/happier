import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { applySettings, settingsDefaults, settingsParse } from './settings';
import { buildMachineTerminalSettingsPatch, resolveTerminalHost, resolveTerminalSpawnOptions } from './terminalSettings';
import { mergePendingSettingsIntoRawBaseline } from '@/sync/engine/settings/writeback/accountSettingsRawDeltaMerge';

// Exact released nested parser from ui-web-v0.2.12 commit
// a357c65536ba89669422977d6f7daf9aa0d17e73, accountRuntimeSettingDefinitions.ts.
// Do not replace this historical reader with the current schema.
const ReleasedSessionTmuxMachineOverrideSchema = z.object({
    useTmux: z.boolean(),
    sessionName: z.string(),
    isolated: z.boolean(),
    tmpDir: z.string().nullable(),
});

describe('resolveTerminalSpawnOptions', () => {
    it('returns null when tmux is disabled', () => {
        const settings: any = {
            ...settingsDefaults,
            sessionUseTmux: false,
        };
        expect(resolveTerminalSpawnOptions({ settings, machineId: 'm1' })).toBeNull();
    });

    it('returns tmux spawn options when enabled', () => {
        const settings: any = {
            ...settingsDefaults,
            sessionUseTmux: true,
            sessionTmuxSessionName: 'happy',
            sessionTmuxIsolated: true,
            sessionTmuxTmpDir: null,
            sessionTmuxByMachineId: {},
        };

        expect(resolveTerminalSpawnOptions({ settings, machineId: 'm1' })).toEqual({
            mode: 'tmux',
            tmux: {
                sessionName: 'happy',
                isolated: true,
                tmpDir: null,
            },
        });
    });

    it('allows blank session name to use current/most recent tmux session', () => {
        const settings: any = {
            ...settingsDefaults,
            sessionUseTmux: true,
            sessionTmuxSessionName: '   ',
            sessionTmuxIsolated: true,
            sessionTmuxTmpDir: null,
            sessionTmuxByMachineId: {},
        };

        const resolved = resolveTerminalSpawnOptions({ settings, machineId: 'm1' });
        expect(resolved?.mode).toBe('tmux');
        if (resolved?.mode !== 'tmux') throw new Error('Expected tmux terminal host');
        expect(resolved.tmux.sessionName).toBe('');
    });

    it('supports per-machine overrides when enabled', () => {
        const settings: any = {
            ...settingsDefaults,
            sessionUseTmux: true,
            sessionTmuxSessionName: 'happy',
            sessionTmuxIsolated: true,
            sessionTmuxTmpDir: null,
            sessionTmuxByMachineId: {
                m1: {
                    useTmux: true,
                    sessionName: 'dev',
                    isolated: false,
                    tmpDir: '/tmp/tmux',
                },
            },
        };

        expect(resolveTerminalSpawnOptions({ settings, machineId: 'm1' })).toEqual({
            mode: 'tmux',
            tmux: {
                sessionName: 'dev',
                isolated: false,
                tmpDir: '/tmp/tmux',
            },
        });
    });

    it('uses Herdr for new sessions when selected globally', () => {
        const settings = { ...settingsDefaults, sessionTerminalHost: 'herdr' as const };
        expect(resolveTerminalSpawnOptions({ settings, machineId: 'm1' })).toEqual({
            mode: 'herdr',
            herdr: { sessionName: 'default' },
        });
    });

    it('lets a machine choose Zellij independently of the global host', () => {
        const settings = {
            ...settingsDefaults,
            sessionTerminalHost: 'herdr' as const,
            sessionTerminalHostByMachineId: { m1: 'zellij' as const },
            sessionTmuxByMachineId: {
                m1: { useTmux: false, sessionName: 'happy', isolated: true, tmpDir: null },
            },
        };
        expect(resolveTerminalSpawnOptions({ settings, machineId: 'm1' })).toEqual({ mode: 'zellij' });
    });

    it('normalizes retained development nested hosts without reviving them after an explicit top-level clear', () => {
        const legacy = {
            sessionTmuxByMachineId: { a: { useTmux: false, terminalHost: 'herdr', sessionName: '', isolated: true, tmpDir: null } },
            futureSetting: { keep: true },
        };
        expect(resolveTerminalHost({ settings: settingsParse(legacy), machineId: 'a' })).toBe('herdr');
        const cleared = mergePendingSettingsIntoRawBaseline({
            rawBaseline: legacy,
            pendingSettings: { sessionTerminalHostByMachineId: {} },
            normalizeForPersistedStorage: (value) => ({ value, changed: false }),
        }).outgoingRaw;
        expect(cleared.sessionTerminalHostByMachineId).toEqual({});
        expect(cleared.sessionTmuxByMachineId).toEqual(legacy.sessionTmuxByMachineId);
        expect(cleared.futureSetting).toEqual({ keep: true });
        expect(resolveTerminalHost({ settings: settingsParse(cleared), machineId: 'a' })).toBe('none');
    });

    it('writes modern host choices and legacy flags in one patch, retaining tmux details and unrelated machines', () => {
        const original = settingsParse({ sessionTerminalHost: 'herdr', sessionTmuxByMachineId: {
            a: { useTmux: true, sessionName: '', isolated: false, tmpDir: '/tmp/a' },
            b: { useTmux: true, sessionName: 'b', isolated: true, tmpDir: null },
        } });
        const herdr = applySettings(original, buildMachineTerminalSettingsPatch({ settings: original, machineId: 'a', host: 'herdr' }));
        expect(herdr.sessionTmuxByMachineId.a).toEqual({ useTmux: false, sessionName: '', isolated: false, tmpDir: '/tmp/a' });
        expect(resolveTerminalHost({ settings: herdr, machineId: 'a' })).toBe('herdr');
        const none = applySettings(herdr, buildMachineTerminalSettingsPatch({ settings: herdr, machineId: 'a', host: 'none' }));
        expect(resolveTerminalSpawnOptions({ settings: none, machineId: 'a' })).toBeNull();
        const tmux = applySettings(none, buildMachineTerminalSettingsPatch({ settings: none, machineId: 'a', host: 'tmux' }));
        expect(resolveTerminalSpawnOptions({ settings: tmux, machineId: 'a' })).toEqual({ mode: 'tmux', tmux: { sessionName: '', isolated: false, tmpDir: '/tmp/a' } });
        const inherited = applySettings(herdr, buildMachineTerminalSettingsPatch({ settings: herdr, machineId: 'a', host: null }));
        expect(resolveTerminalHost({ settings: inherited, machineId: 'a' })).toBe('herdr');
        expect(inherited.sessionTmuxByMachineId.a).toBeUndefined();
        expect(inherited.sessionTerminalHostByMachineId.a).toBeUndefined();
        expect(tmux.sessionTmuxByMachineId.b).toBe(original.sessionTmuxByMachineId.b);
    });

    it('preserves machine A Herdr through the released UI editing machine B', () => {
        // ui-web-v0.2.12, a357c65536ba89669422977d6f7daf9aa0d17e73:
        // SessionTmuxMachineOverrideSchema strips terminalHost; machine/[id]/index
        // writes the complete parsed map. This is its parsed/write-echo vector.
        const originalMap = {
            a: { useTmux: false, sessionName: 'work', isolated: false, tmpDir: '/tmp/work' },
            b: { useTmux: true, sessionName: 'edited', isolated: true, tmpDir: null },
        };
        const rawBaseline = {
            sessionTerminalHost: 'none',
            sessionTerminalHostByMachineId: { a: 'herdr' },
            sessionTmuxByMachineId: {
                ...originalMap,
                a: { ...originalMap.a, terminalHost: 'herdr' },
            },
        };
        const releasedParsedMap = z.record(z.string(), ReleasedSessionTmuxMachineOverrideSchema).parse(rawBaseline.sessionTmuxByMachineId);
        expect(releasedParsedMap).toEqual(originalMap);
        const echo = mergePendingSettingsIntoRawBaseline({
            rawBaseline,
            pendingSettings: { sessionTmuxByMachineId: releasedParsedMap },
            normalizeForPersistedStorage: (value) => ({ value, changed: false }),
        }).outgoingRaw;
        const settings = settingsParse(echo);
        expect(resolveTerminalSpawnOptions({ settings, machineId: 'a' })).toEqual({
            mode: 'herdr', herdr: { sessionName: 'default' },
        });
        expect(resolveTerminalSpawnOptions({ settings, machineId: 'b' })).toEqual({
            mode: 'tmux', tmux: { sessionName: 'edited', isolated: true, tmpDir: null },
        });

        const legacySameMachineEdit = applySettings(settings, {
            sessionTmuxByMachineId: { ...settings.sessionTmuxByMachineId, a: { ...releasedParsedMap.a, useTmux: true } },
        });
        expect(resolveTerminalSpawnOptions({ settings: legacySameMachineEdit, machineId: 'a' })).toEqual({
            mode: 'tmux', tmux: { sessionName: 'work', isolated: false, tmpDir: '/tmp/work' },
        });
    });

    it('preserves explicit global precedence and the released legacy boolean fallback', () => {
        const settings = settingsParse({ sessionTerminalHost: 'herdr', sessionUseTmux: true });
        expect(resolveTerminalHost({ settings, machineId: null })).toBe('herdr');
        const disabled = applySettings(settings, { sessionTerminalHost: 'legacy', sessionUseTmux: false });
        expect(resolveTerminalHost({ settings: disabled, machineId: null })).toBe('none');
    });
});
