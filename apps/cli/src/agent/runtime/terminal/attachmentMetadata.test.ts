import { describe, expect, it } from 'vitest';

import type { TerminalHostHandle } from '@/integrations/terminalHost/_types';

import {
  buildTerminalAttachmentMetadataFromHostHandle,
  buildTerminalHostHandleFromAttachmentMetadata,
} from './attachmentMetadata';

describe('buildTerminalAttachmentMetadataFromHostHandle', () => {
  it('builds tmux terminal metadata from a host handle', () => {
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happy',
      paneId: 'unified-window',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };

    expect(buildTerminalAttachmentMetadataFromHostHandle(handle)).toEqual({
      mode: 'tmux',
      tmux: { target: 'happy:unified-window' },
    });
  });

  it('round-trips the tmux socket root used by released v1 attachments', () => {
    const terminal = {
      mode: 'tmux',
      tmux: {
        target: 'happy:legacy-window',
        tmpDir: '/tmp/happier-tmux-root',
      },
    } as const;

    const handle = buildTerminalHostHandleFromAttachmentMetadata(terminal);
    expect(handle).toMatchObject({
      kind: 'tmux',
      sessionName: 'happy',
      paneId: 'legacy-window',
      socketDir: '/tmp/happier-tmux-root',
    });
    expect(handle && buildTerminalAttachmentMetadataFromHostHandle(handle)).toEqual(terminal);
  });

  it('builds zellij terminal metadata from a host handle', () => {
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happy-zellij',
      paneId: 'terminal_7',
      socketDir: '/tmp/happier-zellij-a',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };

    expect(buildTerminalAttachmentMetadataFromHostHandle(handle)).toEqual({
      mode: 'zellij',
      zellij: {
        sessionName: 'happy-zellij',
        paneId: 'terminal_7',
        socketDirV1: '/tmp/happier-zellij-a',
      },
    });
  });

  it('round-trips a Herdr terminal using its stable terminal identity', () => {
    const handle: TerminalHostHandle = {
      kind: 'herdr',
      sessionName: 'default',
      paneId: 'w1:p2',
      terminalId: 'term_123',
      socketPath: '/tmp/herdr.sock',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const terminal = buildTerminalAttachmentMetadataFromHostHandle(handle);
    expect(terminal).toEqual({
      mode: 'herdr',
      herdr: {
        sessionName: 'default',
        socketPath: '/tmp/herdr.sock',
        terminalId: 'term_123',
        paneId: 'w1:p2',
      },
    });
    expect(terminal && buildTerminalHostHandleFromAttachmentMetadata(terminal)).toMatchObject(handle);
  });

  it('reconstructs the versioned zellij socket root while accepting legacy markers', () => {
    expect(buildTerminalHostHandleFromAttachmentMetadata({
      mode: 'zellij',
      zellij: {
        sessionName: 'happy-zellij',
        paneId: 'terminal_7',
        socketDirV1: '/tmp/happier-zellij-a',
      },
    })).toMatchObject({
      kind: 'zellij',
      sessionName: 'happy-zellij',
      paneId: 'terminal_7',
      socketDir: '/tmp/happier-zellij-a',
    });

    const legacyHandle = buildTerminalHostHandleFromAttachmentMetadata({
      mode: 'zellij',
      zellij: {
        sessionName: 'legacy-zellij',
        paneId: 'terminal_8',
      },
    });
    expect(legacyHandle).toMatchObject({
      kind: 'zellij',
      sessionName: 'legacy-zellij',
      paneId: 'terminal_8',
    });
    expect(legacyHandle?.socketDir).toBeUndefined();
  });

  it('builds non-focusable Windows console metadata from a PTY host handle', () => {
    const handle: TerminalHostHandle = {
      kind: 'windows_console',
      sessionName: 'happy-windows-pty',
      paneId: 'happy-windows-pty',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
        requiresLocalAttachmentInfo: false,
      },
    };

    expect(buildTerminalAttachmentMetadataFromHostHandle(handle)).toEqual({
      mode: 'windows_console',
      requested: 'console',
      windows: {
        host: 'console',
      },
    });
  });
});
