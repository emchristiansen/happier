import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createTerminalAttachmentId,
  readTerminalAttachmentInfo,
  writeTerminalAttachmentInfo,
  type BoundTerminalAttachmentInfo,
  type BorrowedTerminalAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';

import type { TrackedSession } from '../types';
import { publishReportedTerminalControlServiceability } from './publishReportedTerminalControlServiceability';

describe('publishReportedTerminalControlServiceability', () => {
  it('retains borrowed ownership when the runner already published exact serviceability', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-published-borrowed-'));
    const sessionId = 'already-servable-borrowed';
    const attachmentId = createTerminalAttachmentId();
    const terminal = {
      mode: 'herdr' as const,
      herdr: { sessionName: 'default', socketPath: '/tmp/herdr.sock', terminalId: 'terminal_1' },
      controlServiceabilityV1: { v: 1 as const, attachmentId, state: 'servable' as const, observedAt: 1 },
    };
    const tracked: TrackedSession = {
      pid: 43,
      startedBy: 'terminal',
      happySessionId: sessionId,
      happySessionMetadataFromLocalWebhook: {
        path: '/tmp', host: 'test-host', homeDir: '/tmp/home', happyHomeDir,
        happyLibDir: '/tmp/lib', happyToolsDir: '/tmp/tools', terminal,
      },
    };
    try {
      await writeTerminalAttachmentInfo({
        happyHomeDir, sessionId, attachmentId, lifecycle: 'borrowed', terminal,
        handle: {
          attachmentId, kind: 'herdr', sessionName: 'default',
          socketPath: '/tmp/herdr.sock', terminalId: 'terminal_1',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
        },
      });
      await publishReportedTerminalControlServiceability({
        tracked,
        readTerminalAttachmentInfo: async (id) => await readTerminalAttachmentInfo({ happyHomeDir, sessionId: id }),
        probeSessionRunnerServiceability: async () => { throw new Error('Already-published evidence needs no second probe'); },
        publishSessionRunnerControlServiceability: async () => { throw new Error('Already-published evidence needs no second write'); },
      });
      expect(tracked.publishedTerminalControlServiceabilityAttachmentId).toBe(attachmentId);
      expect(tracked.publishedTerminalControlServiceabilityAttachmentLifecycle).toBe('borrowed');
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('probes and publishes a live nested host once per exact attachment', async () => {
    const sessionId = 'sess-nested-host';
    const attachmentId = createTerminalAttachmentId();
    const terminal = {
      mode: 'tmux' as const,
      tmux: { target: 'nested-host:nested-pane' },
    };
    const attachment: BoundTerminalAttachmentInfo = {
      version: 2,
      attachmentId,
      sessionId,
      handle: {
        attachmentId,
        kind: 'tmux',
        sessionName: 'nested-host',
        paneId: 'nested-pane',
        attachMetadata: {
          attachStrategy: 'terminal_host',
          topology: 'exclusive',
          locality: 'same_machine',
          liveProbe: 'required',
        },
      },
      terminal,
      updatedAt: 1,
    };
    const tracked: TrackedSession = {
      pid: 42,
      startedBy: 'daemon',
      happySessionId: sessionId,
      happySessionMetadataFromLocalWebhook: {
        path: '/tmp',
        host: 'test-host',
        homeDir: '/tmp/home',
        happyHomeDir: '/tmp/happier',
        happyLibDir: '/tmp/happier/lib',
        happyToolsDir: '/tmp/happier/tools',
        terminal,
      },
    };
    const readTerminalAttachmentInfo = vi.fn(async (_sessionId: string) => attachment);
    const probeSessionRunnerServiceability = vi.fn(async () => ({
      state: 'runner_present' as const,
      control: { state: 'servable' as const },
    }));
    const publishSessionRunnerControlServiceability = vi.fn(async () => true);

    await publishReportedTerminalControlServiceability({
      tracked,
      readTerminalAttachmentInfo,
      probeSessionRunnerServiceability,
      publishSessionRunnerControlServiceability,
    });
    await publishReportedTerminalControlServiceability({
      tracked,
      readTerminalAttachmentInfo,
      probeSessionRunnerServiceability,
      publishSessionRunnerControlServiceability,
    });

    expect(probeSessionRunnerServiceability).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(publishSessionRunnerControlServiceability).toHaveBeenCalledExactlyOnceWith(
      sessionId,
      {
        state: 'runner_present',
        control: { state: 'servable' },
      },
    );
    expect(tracked.publishedTerminalControlServiceabilityAttachmentId).toBe(attachmentId);
  });

  it('publishes a borrowed terminal while its foreground runner is alive', async () => {
    const sessionId = 'sess-borrowed-herdr';
    const attachmentId = createTerminalAttachmentId();
    const terminal = {
      mode: 'herdr' as const,
      herdr: {
        sessionName: 'default',
        socketPath: '/tmp/herdr.sock',
        terminalId: 'terminal_1',
      },
    };
    const attachment: BorrowedTerminalAttachmentInfo = {
      version: 3,
      lifecycle: 'borrowed',
      attachmentId,
      sessionId,
      handle: {
        attachmentId,
        kind: 'herdr',
        sessionName: 'default',
        socketPath: '/tmp/herdr.sock',
        terminalId: 'terminal_1',
        attachMetadata: {
          attachStrategy: 'terminal_host',
          topology: 'shared',
          locality: 'same_machine',
          maxClients: 1,
          requiresLocalAttachmentInfo: true,
          liveProbe: 'required',
        },
      },
      terminal,
      updatedAt: 1,
    };
    const tracked: TrackedSession = {
      pid: 43,
      startedBy: 'terminal',
      happySessionId: sessionId,
      happySessionMetadataFromLocalWebhook: {
        path: '/tmp',
        host: 'test-host',
        homeDir: '/tmp/home',
        happyHomeDir: '/tmp/happier',
        happyLibDir: '/tmp/happier/lib',
        happyToolsDir: '/tmp/happier/tools',
        terminal,
      },
    };
    const publishSessionRunnerControlServiceability = vi.fn(async () => true);

    await publishReportedTerminalControlServiceability({
      tracked,
      readTerminalAttachmentInfo: async () => attachment,
      probeSessionRunnerServiceability: async () => ({
        state: 'runner_present',
        control: { state: 'servable' },
      }),
      publishSessionRunnerControlServiceability,
    });

    expect(publishSessionRunnerControlServiceability).toHaveBeenCalledOnce();
    expect(tracked.publishedTerminalControlServiceabilityAttachmentId).toBe(attachmentId);
    expect(tracked.publishedTerminalControlServiceabilityAttachmentLifecycle).toBe('borrowed');
  });
});
