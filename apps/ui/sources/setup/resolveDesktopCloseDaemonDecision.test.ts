import { describe, expect, it } from 'vitest';

import { resolveDesktopCloseDaemonDecision } from './resolveDesktopCloseDaemonDecision';

describe('resolveDesktopCloseDaemonDecision', () => {
    it('stops the background service when the app closes, nothing is running, and it is on-demand', () => {
        expect(resolveDesktopCloseDaemonDecision({
            autostart: 'on-demand',
            activeLocalSessionCount: 0,
            canSeeDaemonSessions: true,
        })).toBe('stop');
    });

    it('asks when agent sessions on this computer are still active', () => {
        expect(resolveDesktopCloseDaemonDecision({
            autostart: 'on-demand',
            activeLocalSessionCount: 1,
            canSeeDaemonSessions: true,
        })).toBe('ask');
    });

    it('never stops a service the user asked to start at login', () => {
        expect(resolveDesktopCloseDaemonDecision({
            autostart: 'at-login',
            activeLocalSessionCount: 0,
            canSeeDaemonSessions: true,
        })).toBe('keepInMenuBar');
    });

    it('leaves the service running when the autostart mode could not be read', () => {
        // Unknown stays unknown: stopping here would take the computer off the air on a guess.
        expect(resolveDesktopCloseDaemonDecision({
            autostart: null,
            activeLocalSessionCount: 0,
            canSeeDaemonSessions: true,
        })).toBe('leaveRunning');
    });

    it('asks rather than stopping when the app cannot see what this daemon is running (H4)', () => {
        // The session count comes from the app's own store, which holds the sessions of the relay
        // and account the APP is on — and is emptied entirely on sign-out. A daemon paired to
        // another account, or an app with no account, therefore reports zero running sessions for
        // a computer that may be running several. Zero-because-invisible must never be read as
        // "nothing to lose".
        expect(resolveDesktopCloseDaemonDecision({
            autostart: 'on-demand',
            activeLocalSessionCount: 0,
            canSeeDaemonSessions: false,
        })).toBe('askUnknown');
    });

    it('says it cannot tell, rather than claiming sessions are running, when it cannot see them (U11)', () => {
        // Same ask, different truth: the "sessions are still running" question is only true when
        // the app actually saw them.
        expect(resolveDesktopCloseDaemonDecision({
            autostart: 'on-demand',
            activeLocalSessionCount: 2,
            canSeeDaemonSessions: true,
        })).toBe('ask');
    });

    describe('R16 — menu-bar mode and the split Quit', () => {
        it('keeps the tray and the services when the service starts at login', () => {
            expect(resolveDesktopCloseDaemonDecision({
                autostart: 'at-login',
                activeLocalSessionCount: 2,
                canSeeDaemonSessions: true,
            })).toBe('keepInMenuBar');
        });

        it('"Stop background services and quit" stops them whatever the login-start setting says', () => {
            for (const autostart of ['at-login', 'on-demand', null] as const) {
                expect(resolveDesktopCloseDaemonDecision({
                    intent: 'stopServices',
                    autostart,
                    activeLocalSessionCount: 0,
                    canSeeDaemonSessions: true,
                })).toBe('stop');
            }
        });

        it('still asks before ending sessions it sees, or cannot see, when told to stop everything', () => {
            expect(resolveDesktopCloseDaemonDecision({
                intent: 'stopServices',
                autostart: 'at-login',
                activeLocalSessionCount: 1,
                canSeeDaemonSessions: true,
            })).toBe('ask');
            expect(resolveDesktopCloseDaemonDecision({
                intent: 'stopServices',
                autostart: 'at-login',
                activeLocalSessionCount: 0,
                canSeeDaemonSessions: false,
            })).toBe('askUnknown');
        });
    });
});
