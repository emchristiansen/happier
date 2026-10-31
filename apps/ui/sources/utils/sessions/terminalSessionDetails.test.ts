import { describe, it, expect } from 'vitest';

import { getAttachCommandForSession, getTmuxFallbackReason, getTmuxTargetForSession } from './terminalSessionDetails';

describe('terminalSessionDetails', () => {
    it('offers attach for Herdr and Zellij panes with complete identities', () => {
        expect(getAttachCommandForSession({
            sessionId: 's-herdr',
            terminal: { mode: 'herdr', herdr: { sessionName: 'default', socketPath: '/tmp/herdr.sock', terminalId: 'term_1' } },
        })).toBe('happier attach s-herdr');
        expect(getAttachCommandForSession({
            sessionId: 's-zellij',
            terminal: { mode: 'zellij', zellij: { sessionName: 'happy', paneId: 'terminal_1' } },
        })).toBe('happier attach s-zellij');
    });

    it('returns an attach command when tmux target exists', () => {
        expect(getAttachCommandForSession({
            sessionId: 's1',
            terminal: {
                mode: 'tmux',
                tmux: { target: 'happy:win-1' },
            },
        } as any)).toBe('happier attach s1');
    });

    it('returns null attach command when terminal is not tmux', () => {
        expect(getAttachCommandForSession({
            sessionId: 's1',
            terminal: {
                mode: 'plain',
                requested: 'tmux',
            },
        } as any)).toBeNull();
    });

    it('returns an attach command for windows terminal sessions', () => {
        expect(getAttachCommandForSession({
            sessionId: 's1',
            terminal: {
                mode: 'windows_terminal',
                windows: { host: 'windows_terminal', windowId: 'happy-session-1' },
            },
        } as any)).toBe('happier attach s1');
    });

    it('returns an attach command for windows console sessions even when the remote metadata does not include a pid', () => {
        expect(getAttachCommandForSession({
            sessionId: 's1',
            terminal: {
                mode: 'windows_console',
                windows: { host: 'console' },
            },
        } as any)).toBe('happier attach s1');
    });

    it('returns tmux target when present', () => {
        expect(getTmuxTargetForSession({
            mode: 'tmux',
            tmux: { target: 'happy:win-1', tmpDir: '/tmp' },
        } as any)).toBe('happy:win-1');
    });

    it('returns tmux fallback reason when present', () => {
        expect(getTmuxFallbackReason({
            mode: 'plain',
            requested: 'tmux',
            fallbackReason: 'tmux not found',
        } as any)).toBe('tmux not found');
    });

    it('returns null attach command when tmux metadata is malformed', () => {
        expect(getAttachCommandForSession({
            sessionId: 's1',
            terminal: {
                mode: 'tmux',
                tmux: {} as any,
            },
        } as any)).toBeNull();
    });

    it('returns null tmux fallback reason when terminal mode/request do not match fallback path', () => {
        expect(getTmuxFallbackReason({
            mode: 'plain',
            requested: 'plain',
            fallbackReason: 'ignored',
        } as any)).toBeNull();
        expect(getTmuxFallbackReason({
            mode: 'tmux',
            requested: 'tmux',
            fallbackReason: 'ignored',
        } as any)).toBeNull();
    });
});
