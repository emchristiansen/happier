import { describe, expect, it } from 'vitest';
import * as protocol from '../index.js';
import { SessionTerminalMetadataSchema as ReleasedUiTerminalSchema } from './fixtures/uiWeb0212TerminalMetadata.js';

describe('sessionMetadata terminal metadata', () => {
  it.each(['herdr', 'plain'] as const)('round-trips %s hosting with a Herdr preference through the released UI reader', (mode) => {
    const metadata = {
      path: '/repo', host: 'machine', name: 'original',
      terminal: {
        mode, requested: 'herdr' as const,
        ...(mode === 'herdr' ? {
          herdr: { sessionName: 'work', socketPath: '/tmp/herdr.sock', terminalId: 'term_123' },
        } : { fallbackReason: 'runtime_has_no_terminal' }),
      },
      providerExtension: { retained: true },
    };
    const wire = protocol.projectSessionMetadataForWire(metadata);
    expect(wire).toMatchObject({ terminal: { mode: 'plain', requested: 'plain', requestedHostKind: 'herdr' } });
    if (!wire || typeof wire !== 'object' || !('terminal' in wire)) throw new Error('Missing terminal projection');
    const oldTerminal = ReleasedUiTerminalSchema.parse(wire.terminal);
    expect(oldTerminal.mode).toBe('plain');
    const oldUiMutation = { ...metadata, name: 'renamed', terminal: oldTerminal };
    const hydrated = protocol.normalizeSessionMetadataForRead(oldUiMutation);
    expect(hydrated).toEqual({ ...metadata, name: 'renamed' });
    expect(protocol.projectSessionMetadataForWire(hydrated)).toEqual({ ...wire, name: 'renamed' });
    expect(metadata.name).toBe('original');
    expect(metadata.terminal.mode).toBe(mode);
  });

  it('does not retain a wire selector when a canonical terminal changes hosts', () => {
    const hydrated = protocol.normalizeSessionMetadataForRead({ terminal: {
      mode: 'plain', hostKind: 'herdr', requested: 'plain', requestedHostKind: 'herdr',
      herdr: { sessionName: 'work', socketPath: '/tmp/herdr.sock', terminalId: 'term_123' },
    } });
    const wire = protocol.projectSessionMetadataForWire({ terminal: {
      ...hydrated.terminal, mode: 'tmux', requested: 'tmux', tmux: { target: 'work:1' },
    } });
    expect(wire).toMatchObject({ terminal: { mode: 'tmux', requested: 'tmux' } });
    expect(wire).not.toMatchObject({ terminal: { hostKind: 'herdr' } });
    expect(wire).not.toMatchObject({ terminal: { requestedHostKind: 'herdr' } });
  });
  it('reads the additive Herdr wire projection without leaving competing mode selectors in domain metadata', () => {
    const parsed = protocol.SessionTerminalMetadataSchema.parse({
      mode: 'plain',
      hostKind: 'herdr',
      requested: 'plain',
      requestedHostKind: 'herdr',
      herdr: { sessionName: 'work', socketPath: '/tmp/herdr.sock', terminalId: 'term_123' },
      providerExtension: { retained: true },
    });
    expect(parsed).toEqual({
      mode: 'herdr',
      requested: 'herdr',
      herdr: { sessionName: 'work', socketPath: '/tmp/herdr.sock', terminalId: 'term_123' },
      providerExtension: { retained: true },
    });
  });
  it('keeps the stable Herdr terminal identity needed after a pane moves', () => {
    expect(protocol.SessionTerminalMetadataSchema.parse({
      mode: 'herdr',
      requested: 'herdr',
      herdr: {
        sessionName: 'work',
        socketPath: '/tmp/herdr.sock',
        terminalId: 'term_123',
        paneId: 'w1:p2',
      },
    })).toMatchObject({
      mode: 'herdr',
      herdr: { terminalId: 'term_123' },
    });
  });
  it('parses tmux terminal metadata and preserves unknown fields', () => {
    const parsed = (protocol as any).SessionTerminalMetadataSchema.parse({
      mode: 'tmux',
      requested: 'tmux',
      tmux: { target: 'happy:win-1', tmpDir: '/tmp/x' },
      extra: 'x',
    });
    expect(parsed.mode).toBe('tmux');
    expect((parsed as any).extra).toBe('x');
  });

  it('accepts tmux.tmpDir=null for backward compatibility', () => {
    const parsed = (protocol as any).SessionTerminalMetadataSchema.parse({
      mode: 'tmux',
      tmux: { target: 'happy:win-1', tmpDir: null },
    });
    expect(parsed.mode).toBe('tmux');
    expect((parsed as any).tmux?.tmpDir).toBe(null);
  });

  it('parses versioned zellij socket-root attestation metadata', () => {
    const parsed = (protocol as any).SessionTerminalMetadataSchema.parse({
      mode: 'zellij',
      requested: 'zellij',
      zellij: {
        sessionName: 'happier-claude-unified-1',
        paneId: 'terminal_2',
        socketDirV1: '/tmp/happier-zellij-a',
      },
    });
    expect(parsed.mode).toBe('zellij');
    expect((parsed as any).zellij?.sessionName).toBe('happier-claude-unified-1');
    expect((parsed as any).zellij?.paneId).toBe('terminal_2');
    expect((parsed as any).zellij?.socketDirV1).toBe('/tmp/happier-zellij-a');
  });

  it('parses windows terminal metadata', () => {
    const parsed = (protocol as any).SessionTerminalMetadataSchema.parse({
      mode: 'windows_terminal',
      requested: 'windows_terminal',
      windows: {
        host: 'windows_terminal',
        windowId: 'happy-session-1',
        pid: 123,
      },
    });
    expect(parsed.mode).toBe('windows_terminal');
    expect((parsed as any).windows?.windowId).toBe('happy-session-1');
  });

  it('parses windows console metadata', () => {
    const parsed = (protocol as any).SessionTerminalMetadataSchema.parse({
      mode: 'windows_console',
      requested: 'console',
      windows: {
        host: 'console',
        pid: 456,
      },
    });
    expect(parsed.mode).toBe('windows_console');
    expect((parsed as any).windows?.host).toBe('console');
  });

  it('parses the public recoverable terminal-host lifecycle projection', () => {
    const parsed = (protocol as any).SessionTerminalMetadataSchema.parse({
      mode: 'tmux',
      tmux: { target: 'happy:win-1' },
      controlServiceabilityV1: {
        v: 1,
        attachmentId: 'attachment-1',
        state: 'recoverable_unservable',
        observedAt: 123,
        reason: 'session_rpc_unavailable',
      },
    });
    expect(parsed.controlServiceabilityV1).toEqual({
      v: 1,
      attachmentId: 'attachment-1',
      state: 'recoverable_unservable',
      observedAt: 123,
      reason: 'session_rpc_unavailable',
    });
  });

  it('derives one fail-closed terminal host policy for destructive actions', () => {
    const resolvePolicy = (protocol as any).resolveTerminalControlServiceabilityPolicy;
    expect(resolvePolicy(undefined)).toEqual({
      hostPresence: 'absent',
      canRequestStop: false,
    });
    expect(resolvePolicy({
      v: 1,
      state: 'recoverable_unservable',
      observedAt: 123,
      reason: 'control_descriptor_missing',
    })).toEqual({
      hostPresence: 'preserved',
      canRequestStop: false,
    });
    expect(resolvePolicy({
      v: 1,
      attachmentId: 'attachment-retired',
      state: 'recoverable_unservable',
      observedAt: 124,
      retired: true,
    })).toEqual({
      hostPresence: 'retired',
      canRequestStop: false,
    });
  });

  it('accepts a legacy retirement tombstone written before terminal mode was preserved', () => {
    const parsed = (protocol as any).SessionTerminalMetadataSchema.parse({
      controlServiceabilityV1: {
        v: 1,
        attachmentId: 'attachment-retired',
        state: 'unknown',
        observedAt: 456,
        reason: 'attachment_retired',
        retired: true,
      },
    });

    expect(parsed.mode).toBeUndefined();
    expect(parsed.controlServiceabilityV1).toMatchObject({
      attachmentId: 'attachment-retired',
      state: 'unknown',
      retired: true,
    });
  });

  it('still rejects mode-less terminal metadata that is not a retirement tombstone', () => {
    expect((protocol as any).SessionTerminalMetadataSchema.safeParse({
      controlServiceabilityV1: {
        v: 1,
        attachmentId: 'attachment-live',
        state: 'servable',
        observedAt: 789,
      },
    }).success).toBe(false);
  });
});
