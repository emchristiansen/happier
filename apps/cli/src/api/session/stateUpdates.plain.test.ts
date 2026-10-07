import { describe, expect, it, vi } from 'vitest';

import {
  updateSessionAgentStateWithAck,
  updateSessionMetadataWithAck,
} from './stateUpdates';
import { logger } from '@/ui/logger';
import type { Metadata } from '../types';
import { decodeBase64, decrypt } from '../encryption';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

describe('stateUpdates (plaintext sessions)', () => {
  it.each(['plain', 'e2ee'] as const)('keeps Herdr metadata readable by released UIs across %s metadata acknowledgements', async (mode) => {
    let metadata: Metadata | null = createTestMetadata({
      path: '/tmp', host: 'localhost',
      terminal: {
        mode: 'herdr', requested: 'herdr',
        herdr: { sessionName: 'work', socketPath: '/tmp/herdr.sock', terminalId: 'term_123' },
      },
    });
    let version = 1;
    const encryptionKey = new Uint8Array(32);
    const socket = {
      emitWithAck: async (_event: string, payload: { metadata: string; expectedVersion: number }) => {
        const wire: unknown = mode === 'plain'
          ? JSON.parse(payload.metadata)
          : decrypt(encryptionKey, 'legacy', decodeBase64(payload.metadata));
        expect(wire).toMatchObject({
          name: 'renamed',
          terminal: { mode: 'plain', hostKind: 'herdr', requested: 'plain', requestedHostKind: 'herdr' },
        });
        return { result: 'success', metadata: payload.metadata, version: payload.expectedVersion + 1 };
      },
    };
    await updateSessionMetadataWithAck({
      socket, sessionId: 's1', sessionEncryptionMode: mode,
      encryptionKey, encryptionVariant: 'legacy',
      getMetadata: () => metadata, setMetadata: (next) => { metadata = next; },
      getMetadataVersion: () => version, setMetadataVersion: (next) => { version = next; },
      syncSessionSnapshotFromServer: async () => {},
      handler: (current) => ({ ...current, name: 'renamed' }),
    });
    expect(metadata?.terminal).toEqual({
      mode: 'herdr', requested: 'herdr',
      herdr: { sessionName: 'work', socketPath: '/tmp/herdr.sock', terminalId: 'term_123' },
    });
    expect(version).toBe(2);
  });
  it('sends + applies plaintext metadata updates when session encryption mode is plain', async () => {
    const emitWithAck = vi.fn(async (_event: string, payload: any) => {
      expect(typeof payload.metadata).toBe('string');
      expect(payload.metadata).toContain('"path":"');
      return {
        result: 'success',
        metadata: payload.metadata,
        version: payload.expectedVersion + 1,
      };
    });

    const socket = { emitWithAck };

    let metadata: any = { path: '/tmp', host: 'localhost' };
    let version = 1;

    await updateSessionMetadataWithAck({
      socket,
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      getMetadata: () => metadata,
      setMetadata: (next) => {
        metadata = next;
      },
      getMetadataVersion: () => version,
      setMetadataVersion: (next) => {
        version = next;
      },
      syncSessionSnapshotFromServer: async () => {},
      handler: (current) => ({ ...current, path: '/tmp2' }),
    });

    expect(metadata.path).toBe('/tmp2');
    expect(version).toBe(2);
  });

  it('logs currentModeId from the canonical sessionModesV1 metadata key', async () => {
    const emitWithAck = vi.fn(async (_event: string, payload: any) => ({
      result: 'success',
      metadata: payload.metadata,
      version: payload.expectedVersion + 1,
    }));

    const socket = { emitWithAck };
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    let metadata: any = { path: '/tmp', host: 'localhost' };
    let version = 1;

    await updateSessionMetadataWithAck({
      socket,
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      getMetadata: () => metadata,
      setMetadata: (next) => {
        metadata = next;
      },
      getMetadataVersion: () => version,
      setMetadataVersion: (next) => {
        version = next;
      },
      syncSessionSnapshotFromServer: async () => {},
      handler: (current) => ({
        ...current,
        sessionModesV1: {
          v: 1,
          provider: 'codex',
          updatedAt: 1,
          currentModeId: 'plan',
          availableModes: [{ id: 'plan', name: 'Plan' }],
        },
      }),
    });

    expect(debugSpy).toHaveBeenCalledWith(
      '[API] updateMetadata attempting',
      expect.objectContaining({ currentModeId: 'plan' }),
    );
    expect(debugSpy).toHaveBeenCalledWith(
      '[API] updateMetadata success',
      expect.objectContaining({ currentModeId: 'plan' }),
    );

    debugSpy.mockRestore();
  });

  it('sends projected request counts with update-state payloads', async () => {
    const emitWithAck = vi.fn(async (_event: string, payload: any) => {
      expect(payload.activitySummaryV1).toEqual({
        pendingPermissionRequestCount: 1,
        pendingUserActionRequestCount: 1,
      });
      return {
        result: 'success',
        agentState: payload.agentState,
        version: payload.expectedVersion + 1,
      };
    });

    const socket = { emitWithAck };

    let agentState: any = { requests: {}, completedRequests: {} };
    let version = 1;

    await updateSessionAgentStateWithAck({
      socket,
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      getAgentState: () => agentState,
      setAgentState: (next) => {
        agentState = next;
      },
      getAgentStateVersion: () => version,
      setAgentStateVersion: (next) => {
        version = next;
      },
      syncSessionSnapshotFromServer: async () => {},
      handler: () => ({
        requests: {
          req_permission: {
            tool: 'Write',
            arguments: { path: '/tmp/a.ts' },
            createdAt: 1,
          },
          req_action: {
            tool: 'AskUserQuestion',
            kind: 'user_action',
            arguments: { question: 'Ship it?' },
            createdAt: 2,
          },
          req_completed: {
            tool: 'Write',
            arguments: { path: '/tmp/b.ts' },
            createdAt: 3,
          },
        },
        completedRequests: {
          req_completed: {
            tool: 'Write',
            arguments: { path: '/tmp/b.ts' },
            createdAt: 3,
            status: 'approved',
            completedAt: 4,
          },
        },
      }),
    });

    expect(agentState.requests.req_permission.tool).toBe('Write');
    expect(version).toBe(2);
  });

  it('does not send stale runtime issue summaries with update-state payloads', async () => {
    const runtimeIssueSummaryV1 = {
      latestTurnStatus: 'failed',
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1_778_089_800_000,
        provider: 'codex',
        sanitizedPreview: 'Usage limit reached',
      },
    } as const;
    const emitWithAck = vi.fn(async (_event: string, payload: any) => {
      expect(payload).not.toHaveProperty('runtimeIssueSummaryV1');
      return {
        result: 'success',
        agentState: payload.agentState,
        version: payload.expectedVersion + 1,
      };
    });

    let agentState: any = { requests: {}, completedRequests: {} };
    let version = 1;

    const updateWithStaleRuntimeIssueSummary = {
      socket: { emitWithAck },
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      getAgentState: () => agentState,
      setAgentState: (next) => {
        agentState = next;
      },
      getAgentStateVersion: () => version,
      setAgentStateVersion: (next) => {
        version = next;
      },
      syncSessionSnapshotFromServer: async () => {},
      handler: (current) => current,
      runtimeIssueSummaryV1,
    } satisfies Parameters<typeof updateSessionAgentStateWithAck>[0] & {
      runtimeIssueSummaryV1: typeof runtimeIssueSummaryV1;
    };

    await updateSessionAgentStateWithAck(updateWithStaleRuntimeIssueSummary);

    expect(version).toBe(2);
  });

  it('rejects metadata updates when snapshot sync cannot establish a metadata version', async () => {
    const emitWithAck = vi.fn();
    const syncSessionSnapshotFromServer = vi.fn(async () => undefined);
    let metadata: any = { path: '/tmp', host: 'localhost' };
    let version = -1;

    await expect(updateSessionMetadataWithAck({
      socket: { emitWithAck },
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      getMetadata: () => metadata,
      setMetadata: (next) => {
        metadata = next;
      },
      getMetadataVersion: () => version,
      setMetadataVersion: (next) => {
        version = next;
      },
      syncSessionSnapshotFromServer,
      handler: (current) => ({ ...current, path: '/tmp2' }),
    })).rejects.toThrow(/metadataVersion/i);

    expect(syncSessionSnapshotFromServer).toHaveBeenCalled();
    expect(emitWithAck).not.toHaveBeenCalled();
  });

  it('updates metadata from an empty object when the local metadata snapshot is unavailable but versioned', async () => {
    const emitWithAck = vi.fn(async (_event: string, payload: any) => ({
      result: 'success',
      metadata: payload.metadata,
      version: payload.expectedVersion + 1,
    }));
    let metadata: any = null;
    let version = 4;
    const seenMetadata: any[] = [];

    await updateSessionMetadataWithAck({
      socket: { emitWithAck },
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      getMetadata: () => metadata,
      setMetadata: (next) => {
        metadata = next;
      },
      getMetadataVersion: () => version,
      setMetadataVersion: (next) => {
        version = next;
      },
      syncSessionSnapshotFromServer: async () => {},
      handler: (current) => {
        seenMetadata.push(current);
        return { ...current, claudeSessionId: 'claude-1' } as any;
      },
    });

    expect(seenMetadata).toEqual([{}]);
    expect(metadata).toEqual({ claudeSessionId: 'claude-1' });
    expect(version).toBe(5);
  });

  it('rejects metadata update acks that are neither success nor version mismatch', async () => {
    const privateServerError = 'fixture-private-server-error';
    const emitWithAck = vi.fn(async () => ({ result: 'error', error: privateServerError }));
    const initialMetadata = createTestMetadata({ path: '/private/workspace', host: 'localhost' });
    let metadata: Metadata | null = initialMetadata;
    let version = 1;
    const infoFile = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});

    try {
      await expect(updateSessionMetadataWithAck({
        socket: { emitWithAck },
        sessionId: 's1',
        sessionEncryptionMode: 'plain',
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy',
        getMetadata: () => metadata,
        setMetadata: (next) => {
          metadata = next;
        },
        getMetadataVersion: () => version,
        setMetadataVersion: (next) => {
          version = next;
        },
        syncSessionSnapshotFromServer: async () => {},
        handler: (current) => ({ ...current, path: '/tmp2' }),
      })).rejects.toMatchObject({ code: 'metadata_update_failed', retryable: false });
      expect(metadata).toBe(initialMetadata);
      expect(version).toBe(1);
      expect(infoFile.mock.calls).toEqual([[
        expect.any(String),
        { phase: 'terminal_failure', operation: 'update-metadata', sessionId: 's1' },
      ]]);
      expect(JSON.stringify(infoFile.mock.calls)).not.toContain(privateServerError);
      expect(JSON.stringify(infoFile.mock.calls)).not.toContain('/private/workspace');
    } finally {
      infoFile.mockRestore();
    }
  });

  it('re-runs metadata updater against refreshed metadata after a version mismatch', async () => {
    const emitWithAck = vi.fn(async (_event: string, payload: any) => {
      if (payload.expectedVersion === 1) {
        return {
          result: 'version-mismatch',
          metadata: JSON.stringify({ path: '/server', host: 'localhost', serverOnly: true }),
          version: 2,
        };
      }
      return {
        result: 'success',
        metadata: payload.metadata,
        version: 3,
      };
    });
    let metadata: any = { path: '/tmp', host: 'localhost' };
    let version = 1;
    const seenPaths: string[] = [];

    await updateSessionMetadataWithAck({
      socket: { emitWithAck },
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      getMetadata: () => metadata,
      setMetadata: (next) => {
        metadata = next;
      },
      getMetadataVersion: () => version,
      setMetadataVersion: (next) => {
        version = next;
      },
      syncSessionSnapshotFromServer: async () => {},
      handler: (current) => {
        seenPaths.push(String((current as any).path));
        return { ...current, clientOnly: true };
      },
    });

    expect(seenPaths).toEqual(['/tmp', '/server']);
    expect(metadata).toMatchObject({ path: '/server', serverOnly: true, clientOnly: true });
    expect(version).toBe(3);
  });

  it('does not leave metadata updates pending forever when the socket ack never settles', async () => {
    vi.useFakeTimers();
    vi.stubEnv('HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS', '5');

    const emitWithAck = vi.fn(() => new Promise<never>(() => {}));
    const timeout = vi.fn(() => ({ emitWithAck }));
    let metadata: any = { path: '/tmp', host: 'localhost' };
    let version = 1;
    let observedError: unknown = null;

    const updatePromise = updateSessionMetadataWithAck({
      socket: { timeout, emitWithAck },
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      getMetadata: () => metadata,
      setMetadata: (next) => {
        metadata = next;
      },
      getMetadataVersion: () => version,
      setMetadataVersion: (next) => {
        version = next;
      },
      syncSessionSnapshotFromServer: async () => {},
      handler: (current) => ({ ...current, path: '/tmp2' }),
    }).catch((error) => {
      observedError = error;
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);

      expect(observedError).toBeInstanceOf(Error);
      expect((observedError as Error).message).toMatch(/ack timed out/i);
      expect(metadata.path).toBe('/tmp');
      await updatePromise;
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });
});
