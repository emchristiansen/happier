import { describe, expect, it, vi } from 'vitest';
import * as tmp from 'tmp';
import { writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TerminalAttachmentId, TerminalHostAdapter, TerminalHostHandle } from '@/integrations/terminalHost/_types';
import { logger } from '@/ui/logger';

import {
  readTerminalAttachmentInfo,
  removeTerminalAttachmentInfo,
  writeTerminalAttachmentInfo,
} from './terminalAttachmentInfo';
import {
  executeConfirmedDeadTerminalAttachmentRetirement,
  executeTerminalHostDisposition,
} from './terminalHostDisposition';

const filesystemReadGate = vi.hoisted(() => ({
  beforeRead: null as ((path: unknown) => void) | null,
  beforeUnlink: null as ((path: unknown) => void) | null,
}));
// Only the OS read is controlled; descriptor parsing, locks and disposition stay real.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, unlink: async (...args: Parameters<typeof actual.unlink>) => {
    filesystemReadGate.beforeUnlink?.(args[0]);
    return await actual.unlink(...args);
  }, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    filesystemReadGate.beforeRead?.(args[0]);
    return await actual.readFile(...args);
  } };
});

const HANDLE = {
  attachmentId: 'attachment-current' as TerminalAttachmentId,
  kind: 'tmux',
  sessionName: 'happy',
  paneId: 'owned-window',
  socketDir: '/tmp/happier-tmux-root',
  attachMetadata: {
    attachStrategy: 'terminal_host',
    topology: 'shared',
    locality: 'same_machine',
    maxClients: null,
    requiresLocalAttachmentInfo: true,
    liveProbe: 'required',
  },
} satisfies TerminalHostHandle & Readonly<{ attachmentId: TerminalAttachmentId }>;

async function persistBoundAttachment(happyHomeDir: string, lifecycle: 'owned' | 'borrowed' = 'owned'): Promise<void> {
  await writeTerminalAttachmentInfo({
    happyHomeDir,
    sessionId: 'session-1',
    attachmentId: HANDLE.attachmentId,
    handle: HANDLE,
    lifecycle,
    terminal: {
      mode: 'tmux',
      tmux: { target: 'happy:owned-window', tmpDir: HANDLE.socketDir },
    },
  });
}

function buildAdapter(dispose: TerminalHostAdapter['dispose']): TerminalHostAdapter {
  return {
    kind: 'tmux',
    createOrAttachHost: async () => HANDLE,
    injectUserPrompt: async () => ({ status: 'injected', at: 1, bytesWritten: 1 }),
    interruptTurn: async () => undefined,
    evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
    dispose,
  };
}

describe('executeTerminalHostDisposition', () => {
  it.each(['invalid', 'io_error'] as const)('retains %s evidence without losing already-proven physical destruction', async (failure) => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await persistBoundAttachment(dir.name);
      const captured = await readTerminalAttachmentInfo({ happyHomeDir: dir.name, sessionId: 'session-1' });
      if (captured?.version !== 2) throw new Error('Expected persisted exact owned fixture');
      await removeTerminalAttachmentInfo({ happyHomeDir: dir.name, sessionId: 'session-1', expectedAttachmentId: captured.attachmentId, expectedTerminal: captured.terminal });
      const descriptorPath = join(dir.name, 'terminal', 'sessions', 'session-1.json');
      const adapter = buildAdapter(async () => {
        if (failure === 'invalid') await writeFile(descriptorPath, '{invalid-json', 'utf8');
        else filesystemReadGate.beforeRead = (path) => {
          if (String(path) === descriptorPath) throw Object.assign(new Error('OS denied attachment read'), { code: 'EACCES' });
        };
      });
      await expect(executeTerminalHostDisposition({ happyHomeDir: dir.name, sessionId: 'session-1', expectedAttachmentId: captured.attachmentId,
        expectedAttachmentInfo: captured, intent: { kind: 'destroy_owned_host', reason: 'explicit_user_stop' }, adapter,
      })).resolves.toEqual({ status: 'destroyed', attachmentId: captured.attachmentId, descriptorRetained: true });
    } finally {
      filesystemReadGate.beforeRead = null;
      dir.removeCallback();
    }
  });

  it('keeps an unreadable second read fenced before any host disposal', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await persistBoundAttachment(dir.name);
      const descriptorPath = join(dir.name, 'terminal', 'sessions', 'session-1.json');
      let reads = 0;
      filesystemReadGate.beforeRead = (path) => {
        if (String(path) === descriptorPath && ++reads === 2) {
          throw Object.assign(new Error('private-filesystem-sentinel'), { code: 'EACCES' });
        }
      };
      const dispose = vi.fn(async () => undefined);
      await expect(executeTerminalHostDisposition({
        happyHomeDir: dir.name, sessionId: 'session-1', expectedAttachmentId: HANDLE.attachmentId,
        intent: { kind: 'destroy_owned_host', reason: 'explicit_user_stop' }, adapter: buildAdapter(dispose),
      })).resolves.toEqual({ status: 'parked', reason: 'missing_topology_proof' });
      expect(dispose).not.toHaveBeenCalled();
      filesystemReadGate.beforeRead = null;
      await expect(readTerminalAttachmentInfo({ happyHomeDir: dir.name, sessionId: 'session-1' }))
        .resolves.toMatchObject({ attachmentId: HANDLE.attachmentId });
    } finally {
      filesystemReadGate.beforeRead = null;
      dir.removeCallback();
    }
  });

  it.each(['release_borrowed_host', 'destroy_owned_host'] as const)('reports exact descriptor unlink failure after %s without losing custody', async (kind) => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await persistBoundAttachment(dir.name, kind === 'release_borrowed_host' ? 'borrowed' : 'owned');
      const descriptorPath = join(dir.name, 'terminal', 'sessions', 'session-1.json');
      filesystemReadGate.beforeUnlink = (path) => {
        if (String(path) === descriptorPath) throw Object.assign(new Error('private-filesystem-sentinel'), { code: 'EACCES' });
      };
      logger.flushSync();
      const priorLogLength = existsSync(logger.getLogPath()) ? readFileSync(logger.getLogPath(), 'utf8').length : 0;
      const dispose = vi.fn(async () => undefined);
      await expect(executeTerminalHostDisposition({
        happyHomeDir: dir.name, sessionId: 'session-1', expectedAttachmentId: HANDLE.attachmentId,
        intent: kind === 'release_borrowed_host'
          ? { kind, reason: 'explicit_user_stop' }
          : { kind, reason: 'explicit_user_stop' },
        adapter: buildAdapter(dispose),
      })).resolves.toEqual(kind === 'release_borrowed_host'
        ? { status: 'parked', reason: 'descriptor_retirement_failed' }
        : { status: 'destroyed', attachmentId: HANDLE.attachmentId, descriptorRetained: true });
      expect(dispose).toHaveBeenCalledTimes(kind === 'release_borrowed_host' ? 0 : 1);
      await expect(readTerminalAttachmentInfo({ happyHomeDir: dir.name, sessionId: 'session-1' }))
        .resolves.toMatchObject({ attachmentId: HANDLE.attachmentId });
      logger.flushSync();
      const diagnostic = readFileSync(logger.getLogPath(), 'utf8').slice(priorLogLength);
      expect(diagnostic).toContain('[TERMINAL HOST]');
      expect(diagnostic).not.toContain('private-filesystem-sentinel');
    } finally {
      filesystemReadGate.beforeUnlink = null;
      dir.removeCallback();
    }
  });

  it('preserves the bound host and attachment metadata on planned refresh', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await persistBoundAttachment(dir.name);

      await expect(executeTerminalHostDisposition({
        happyHomeDir: dir.name,
        sessionId: 'session-1',
        expectedAttachmentId: HANDLE.attachmentId!,
        intent: {
          kind: 'preserve_host',
          reason: 'planned_runner_refresh',
          runtimePhase: 'transfer_pending',
        },
      })).resolves.toEqual({ status: 'preserved', attachmentId: HANDLE.attachmentId });
      await expect(readTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'session-1',
      })).resolves.toMatchObject({ attachmentId: HANDLE.attachmentId, handle: HANDLE });
    } finally {
      dir.removeCallback();
    }
  });

  it('parks stale destroy intent without touching the replacement host or metadata', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await persistBoundAttachment(dir.name);
      const dispose = vi.fn(async () => undefined);

      await expect(executeTerminalHostDisposition({
        happyHomeDir: dir.name,
        sessionId: 'session-1',
        expectedAttachmentId: 'attachment-stale',
        intent: { kind: 'destroy_owned_host', reason: 'explicit_user_stop' },
        adapter: buildAdapter(dispose),
      })).resolves.toMatchObject({ status: 'parked', reason: 'attachment_mismatch' });
      expect(dispose).not.toHaveBeenCalled();
      await expect(readTerminalAttachmentInfo({ happyHomeDir: dir.name, sessionId: 'session-1' }))
        .resolves.toMatchObject({ attachmentId: HANDLE.attachmentId });
    } finally {
      dir.removeCallback();
    }
  });

  it('keeps physical destruction final when descriptor removal loses a replacement race', async () => {
    const dispose = vi.fn(async () => undefined);
    await expect(executeTerminalHostDisposition({
      happyHomeDir: '/tmp/happy',
      sessionId: 'session-removal-race',
      expectedAttachmentId: HANDLE.attachmentId!,
      intent: { kind: 'destroy_owned_host', reason: 'explicit_user_stop' },
      adapter: buildAdapter(dispose),
      readAttachmentInfo: vi.fn(async () => ({
        version: 2 as const,
        attachmentId: HANDLE.attachmentId!,
        sessionId: 'session-removal-race',
        handle: { ...HANDLE, attachmentId: HANDLE.attachmentId! },
        terminal: { mode: 'zellij' as const, zellij: { sessionName: HANDLE.sessionName, paneId: HANDLE.paneId!, socketDirV1: HANDLE.socketDir! } },
        updatedAt: 1,
      })),
      removeAttachmentInfo: vi.fn(async () => false),
    })).resolves.toEqual({ status: 'destroyed', attachmentId: HANDLE.attachmentId, descriptorRetained: true });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('retires the descriptor when disposal reports failure but the exact host is positively dead', async () => {
    const removeAttachmentInfo = vi.fn(async () => true);
    const adapter = buildAdapter(async () => {
      throw Object.assign(new Error('tmux target disappeared during kill'), { code: 'ENOENT' });
    });
    vi.mocked(adapter.evaluateLiveness).mockResolvedValue({
      paneAlive: false,
      paneDead: true,
      observedAt: 2,
    });

    await expect(executeTerminalHostDisposition({
      happyHomeDir: '/tmp/happy',
      sessionId: 'session-disappeared-during-dispose',
      expectedAttachmentId: HANDLE.attachmentId,
      intent: { kind: 'destroy_owned_host', reason: 'explicit_user_stop' },
      adapter,
      readAttachmentInfo: vi.fn(async () => ({
        version: 2 as const,
        attachmentId: HANDLE.attachmentId,
        sessionId: 'session-disappeared-during-dispose',
        handle: HANDLE,
        terminal: { mode: 'tmux' as const, tmux: { target: 'happy:owned-window' } },
        updatedAt: 1,
      })),
      removeAttachmentInfo,
    })).resolves.toEqual({ status: 'destroyed', attachmentId: HANDLE.attachmentId });

    expect(adapter.evaluateLiveness).toHaveBeenCalledWith(HANDLE);
    expect(removeAttachmentInfo).toHaveBeenCalledOnce();
  });

  it('retains the retry descriptor and logs the disposal failure when host death is unproven', async () => {
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const removal = vi.fn(async () => true);
    const disposalError = Object.assign(new Error('permission denied while closing pane'), { code: 'EPERM' });
    const adapter = buildAdapter(async () => {
      throw disposalError;
    });
    vi.mocked(adapter.evaluateLiveness).mockResolvedValue({ paneAlive: true, observedAt: 2 });

    await expect(executeTerminalHostDisposition({
      happyHomeDir: '/tmp/happy',
      sessionId: 'session-dispose-failed',
      expectedAttachmentId: HANDLE.attachmentId,
      intent: { kind: 'destroy_owned_host', reason: 'explicit_user_stop' },
      adapter,
      readAttachmentInfo: vi.fn(async () => ({
        version: 2 as const,
        attachmentId: HANDLE.attachmentId,
        sessionId: 'session-dispose-failed',
        handle: HANDLE,
        terminal: { mode: 'tmux' as const, tmux: { target: 'happy:owned-window' } },
        updatedAt: 1,
      })),
      removeAttachmentInfo: removal,
    })).resolves.toEqual({ status: 'parked', reason: 'destroy_failed' });

    expect(removal).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      '[TERMINAL HOST] Failed to destroy exact terminal host; retaining descriptor for retry',
      expect.objectContaining({
        sessionId: 'session-dispose-failed',
        attachmentId: HANDLE.attachmentId,
        hostKind: 'tmux',
        error: disposalError,
        livenessStatus: 'alive',
      }),
    );
  });

  it('retires remote ownership evidence before removing the local descriptor', async () => {
    const events: string[] = [];
    await expect(executeTerminalHostDisposition({
      happyHomeDir: '/tmp/happy',
      sessionId: 'session-retirement-order',
      expectedAttachmentId: HANDLE.attachmentId!,
      intent: { kind: 'destroy_owned_host', reason: 'explicit_user_stop' },
      adapter: buildAdapter(async () => {
        events.push('destroy');
      }),
      readAttachmentInfo: vi.fn(async () => ({
        version: 2 as const,
        attachmentId: HANDLE.attachmentId!,
        sessionId: 'session-retirement-order',
        handle: HANDLE,
        terminal: { mode: 'tmux' as const, tmux: { target: 'happy:owned-window' } },
        updatedAt: 1,
      })),
      beforeDescriptorRetirement: async () => {
        events.push('remote');
      },
      removeAttachmentInfo: vi.fn(async () => {
        events.push('local');
        return true;
      }),
    })).resolves.toEqual({ status: 'destroyed', attachmentId: HANDLE.attachmentId });
    expect(events).toEqual(['destroy', 'remote', 'local']);
  });

  it('retains the local descriptor when remote ownership retirement fails after destruction', async () => {
    const removeAttachmentInfo = vi.fn(async () => true);
    await expect(executeTerminalHostDisposition({
      happyHomeDir: '/tmp/happy',
      sessionId: 'session-retirement-failure',
      expectedAttachmentId: HANDLE.attachmentId!,
      intent: { kind: 'destroy_owned_host', reason: 'explicit_user_stop' },
      adapter: buildAdapter(async () => undefined),
      readAttachmentInfo: vi.fn(async () => ({
        version: 2 as const,
        attachmentId: HANDLE.attachmentId!,
        sessionId: 'session-retirement-failure',
        handle: HANDLE,
        terminal: { mode: 'tmux' as const, tmux: { target: 'happy:owned-window' } },
        updatedAt: 1,
      })),
      beforeDescriptorRetirement: async () => {
        throw new Error('remote unavailable');
      },
      removeAttachmentInfo,
    })).resolves.toEqual({
      status: 'destroyed',
      attachmentId: HANDLE.attachmentId,
      descriptorRetained: true,
      retirementFailed: true,
    });
    expect(removeAttachmentInfo).not.toHaveBeenCalled();
  });

  it('claims explicit stop once, destroys the persisted handle, and removes by expected-id CAS', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await persistBoundAttachment(dir.name);
      const dispose = vi.fn(async () => undefined);
      const input = {
        happyHomeDir: dir.name,
        sessionId: 'session-1',
        expectedAttachmentId: HANDLE.attachmentId!,
        intent: { kind: 'destroy_owned_host' as const, reason: 'explicit_user_stop' as const },
        adapter: buildAdapter(dispose),
      };

      const results = await Promise.all([
        executeTerminalHostDisposition(input),
        executeTerminalHostDisposition(input),
      ]);

      expect(results.filter((result) => result.status === 'destroyed')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'parked')).toHaveLength(1);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledWith(expect.objectContaining({
        attachmentId: HANDLE.attachmentId,
        sessionName: 'happy',
        paneId: 'owned-window',
        socketDir: '/tmp/happier-tmux-root',
      }));
      await expect(readTerminalAttachmentInfo({ happyHomeDir: dir.name, sessionId: 'session-1' }))
        .resolves.toBeNull();
    } finally {
      dir.removeCallback();
    }
  });

  it('releases a borrowed attachment without disposing the user-owned terminal host', async () => {
    const dispose = vi.fn(async () => undefined);
    const removeAttachmentInfo = vi.fn(async () => true);
    const borrowedAttachment = {
      version: 3 as const,
      lifecycle: 'borrowed' as const,
      attachmentId: HANDLE.attachmentId,
      sessionId: 'session-borrowed',
      handle: HANDLE,
      terminal: { mode: 'tmux' as const, tmux: { target: 'happy:owned-window' } },
      updatedAt: 1,
    };

    await expect(executeTerminalHostDisposition({
      happyHomeDir: '/tmp/happy',
      sessionId: 'session-borrowed',
      expectedAttachmentId: HANDLE.attachmentId,
      intent: { kind: 'release_borrowed_host', reason: 'explicit_user_stop' },
      adapter: buildAdapter(dispose),
      readAttachmentInfo: vi.fn(async () => borrowedAttachment),
      removeAttachmentInfo,
    })).resolves.toEqual({ status: 'retired', attachmentId: HANDLE.attachmentId });

    expect(dispose).not.toHaveBeenCalled();
    expect(removeAttachmentInfo).toHaveBeenCalledWith(expect.objectContaining({
      expectedAttachmentId: HANDLE.attachmentId,
      expectedTerminal: borrowedAttachment.terminal,
    }));
  });

  it('retires an exactly bound confirmed-dead attachment without trying to destroy the already-dead host', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await persistBoundAttachment(dir.name);
      const dispose = vi.fn(async () => {
        throw new Error('the confirmed-dead pane cannot be closed');
      });

      await expect(executeTerminalHostDisposition({
        happyHomeDir: dir.name,
        sessionId: 'session-1',
        expectedAttachmentId: HANDLE.attachmentId!,
        intent: { kind: 'retire_confirmed_dead_attachment', reason: 'positive_dead_recovery' },
        adapter: buildAdapter(dispose),
      })).resolves.toEqual({ status: 'retired', attachmentId: HANDLE.attachmentId });

      expect(dispose).not.toHaveBeenCalled();
      await expect(readTerminalAttachmentInfo({ happyHomeDir: dir.name, sessionId: 'session-1' }))
        .resolves.toBeNull();
    } finally {
      dir.removeCallback();
    }
  });

  it('parks legacy and shared missing-pane attachments without physical destruction', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await writeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'legacy-session',
        terminal: { mode: 'tmux', tmux: { target: 'happy' } },
      });
      const dispose = vi.fn(async () => undefined);

      await expect(executeTerminalHostDisposition({
        happyHomeDir: dir.name,
        sessionId: 'legacy-session',
        expectedAttachmentId: 'attachment-guessed',
        intent: { kind: 'retire_confirmed_dead_attachment', reason: 'positive_dead_recovery' },
        adapter: buildAdapter(dispose),
      })).resolves.toMatchObject({ status: 'parked', reason: 'legacy_attachment' });
      expect(dispose).not.toHaveBeenCalled();
    } finally {
      dir.removeCallback();
    }
  });

  it('retires an unchanged legacy attachment after its host was positively proven dead', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await writeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'legacy-dead-session',
        terminal: {
          mode: 'tmux',
          tmux: { target: 'happy:legacy-window', tmpDir: '/tmp/happier-tmux' },
        },
      });
      const attachmentInfo = await readTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'legacy-dead-session',
      });
      if (!attachmentInfo || attachmentInfo.version !== 1) {
        throw new Error('Expected a legacy attachment fixture');
      }
      await expect(executeConfirmedDeadTerminalAttachmentRetirement({
        happyHomeDir: dir.name,
        sessionId: 'legacy-dead-session',
        expectedAttachmentInfo: attachmentInfo,
      })).resolves.toEqual({ status: 'retired', attachmentId: null });

      await expect(readTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'legacy-dead-session',
      })).resolves.toBeNull();
    } finally {
      dir.removeCallback();
    }
  });
});
