import { describe, expect, it, vi } from 'vitest';
import * as tmp from 'tmp';

import { readTerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import type { TerminalAttachmentId } from '@/integrations/terminalHost/_types';

import { bindSpawnedTerminalHostAttachment } from './bindSpawnedTerminalHostAttachment';
import { bindSpawnedTmuxTerminalAttachment } from './bindSpawnedTmuxTerminalAttachment';

describe('bindSpawnedTmuxTerminalAttachment', () => {
  it('binds an existing Herdr handle to the same attachment owner', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await bindSpawnedTerminalHostAttachment({
        happyHomeDir: dir.name,
        sessionId: 'sess-daemon-herdr',
        handle: {
          attachmentId: 'attachment-daemon-herdr' as TerminalAttachmentId,
          kind: 'herdr',
          sessionName: 'default',
          socketPath: '/tmp/herdr.sock',
          paneId: 'pane_1',
          terminalId: 'terminal_1',
          attachMetadata: {
            attachStrategy: 'terminal_host',
            topology: 'shared',
            locality: 'same_machine',
            liveProbe: 'required',
          },
        },
        disposeUnboundHost: vi.fn(async () => undefined),
      });
      await expect(readTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'sess-daemon-herdr',
      })).resolves.toMatchObject({
        version: 2,
        attachmentId: 'attachment-daemon-herdr',
        terminal: { mode: 'herdr', herdr: { terminalId: 'terminal_1' } },
        handle: {
          attachmentId: 'attachment-daemon-herdr',
          kind: 'herdr',
          terminalId: 'terminal_1',
        },
      });
    } finally {
      dir.removeCallback();
    }
  });
  it('persists immutable shared-window ownership after the Happier session id is known', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await bindSpawnedTmuxTerminalAttachment({
        happyHomeDir: dir.name,
        sessionId: 'sess-daemon-tmux',
        tmuxSessionName: 'happy',
        tmuxWindowId: '@7',
        tmuxTmpDir: '/tmp/happier-tmux',
        disposeUnboundHost: vi.fn(async () => undefined),
      });

      await expect(readTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'sess-daemon-tmux',
      })).resolves.toMatchObject({
        version: 2,
        attachmentId: expect.any(String),
        handle: {
          attachmentId: expect.any(String),
          kind: 'tmux',
          sessionName: 'happy',
          paneId: '@7',
          socketDir: '/tmp/happier-tmux',
          attachMetadata: {
            attachStrategy: 'terminal_host',
            topology: 'shared',
            locality: 'same_machine',
            requiresLocalAttachmentInfo: true,
            liveProbe: 'required',
          },
        },
        terminal: {
          mode: 'tmux',
          tmux: { target: 'happy:@7', tmpDir: '/tmp/happier-tmux' },
        },
      });
    } finally {
      dir.removeCallback();
    }
  });

  it('disposes the exact unbound host when committed attachment persistence fails', async () => {
    const invalidHome = tmp.fileSync();
    const disposeUnboundHost = vi.fn(async () => undefined);
    try {
      await expect(bindSpawnedTmuxTerminalAttachment({
        happyHomeDir: invalidHome.name,
        sessionId: 'sess-bind-failure',
        tmuxSessionName: 'happy',
        tmuxWindowId: '@8',
        disposeUnboundHost,
      })).rejects.toThrow();
      expect(disposeUnboundHost).toHaveBeenCalledOnce();
    } finally {
      invalidHome.removeCallback();
    }
  });
});
