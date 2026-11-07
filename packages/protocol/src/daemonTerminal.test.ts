import { describe, expect, it } from 'vitest';

import { DaemonTerminalEnsureRequestSchema, DaemonTerminalErrorSchema } from './daemonTerminal';

describe('DaemonTerminalErrorSchema', () => {
  it('accepts explicit resize-unavailable errors', () => {
    expect(
      DaemonTerminalErrorSchema.safeParse({
        ok: false,
        errorCode: 'terminal_resize_unavailable',
        error: 'terminal_resize_unavailable',
      }).success,
    ).toBe(true);
  });
});

describe('DaemonTerminalEnsureRequestSchema session attach launch', () => {
  it('accepts a typed session attach intent without a caller-authored terminal key or shell command', () => {
    expect(DaemonTerminalEnsureRequestSchema.parse({
      launch: { kind: 'session_attach', sessionId: 'session-1' },
      cols: 100,
      rows: 30,
    })).toEqual({
      launch: { kind: 'session_attach', sessionId: 'session-1' },
      cols: 100,
      rows: 30,
    });
  });

  it('rejects a raw initial command beside the typed session attach intent', () => {
    expect(DaemonTerminalEnsureRequestSchema.safeParse({
      launch: { kind: 'session_attach', sessionId: 'session-1' },
      initialCommand: 'happier attach session-1',
    }).success).toBe(false);
  });
});

describe('DaemonTerminalEnsureRequestSchema Happier CLI launch', () => {
  it('accepts a typed current-runtime CLI launch without a caller-authored shell command', () => {
    expect(DaemonTerminalEnsureRequestSchema.parse({
      terminalKey: 'provider-login:machine-1:agy:primary',
      launch: { kind: 'happier_cli', args: ['agy', 'auth', 'login'] },
    })).toEqual({
      terminalKey: 'provider-login:machine-1:agy:primary',
      launch: { kind: 'happier_cli', args: ['agy', 'auth', 'login'] },
    });
  });
});
