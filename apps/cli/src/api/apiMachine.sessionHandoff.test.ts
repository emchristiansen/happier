import axios from 'axios';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { SessionHandoffPrepareTargetRequestV2 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { Machine } from '@/api/types';
import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import type { RpcHandlerManager } from './rpc/RpcHandlerManager';

describe('ApiMachineClient existing-state handoff', () => {
  it('prepares the unchanged native transcript using the daemon connected-service environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-api-machine-existing-'));
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'CLAUDE_CONFIG_DIR']);
    const targetPath = join(root, 'workspace');
    const claudeHome = join(root, 'materialized-claude');
    const transcriptPath = join(claudeHome, 'projects', 'existing-project', 'native-1.jsonl');
    const transcript = '{"type":"user","message":{"role":"user","content":"preserved"}}\n';
    // Account lookup is the HTTP boundary. Registration, job persistence,
    // metadata resolution, catalog dispatch and native reachability stay real.
    const accountLookup = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { id: 'account-test' } });
    env.patch({ HAPPIER_HOME_DIR: root, HAPPIER_ACTIVE_SERVER_ID: undefined, CLAUDE_CONFIG_DIR: join(root, 'wrong-claude-home') });
    reloadConfiguration();
    try {
      await mkdir(join(claudeHome, 'projects', 'existing-project'), { recursive: true });
      await mkdir(targetPath);
      await writeFile(transcriptPath, transcript);
      const { ApiMachineClient } = await import('./apiMachine');
      const machine: Machine = {
        id: 'machine-test', encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy',
        metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
      };
      const client = new ApiMachineClient('token', machine);
      client.setRPCHandlers({
        spawnSession: async () => ({ type: 'success', sessionId: 'session-1' }),
        spawnSessionForHandoff: async () => ({ type: 'success', sessionId: 'session-1' }),
        stopSession: async () => true,
        requestShutdown: () => {},
        loadLocalSessionMetadata: async () => ({ exportMetadata: {
          path: targetPath, flavor: 'claude', machineId: machine.id, claudeSessionId: 'native-1',
          connectedServices: { v: 1, bindingsByServiceId: {
            'claude-subscription': { source: 'connected', profileId: 'profile-test' },
          } },
        } }),
        resolveExistingStateEnvironment: async () => ({ ...process.env, CLAUDE_CONFIG_DIR: claudeHome }),
      });
      const rpc = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
      const request = {
        handoffId: 'existing-connected', sessionId: 'session-1', sourceMachineId: machine.id, targetMachineId: machine.id,
        stateTransfer: 'existing', sourceSessionStorageMode: 'persisted', targetPath,
        negotiatedTransportStrategy: 'direct_peer', allowServerRoutedFallback: false, endpointCandidates: [],
      } satisfies SessionHandoffPrepareTargetRequestV2;
      await rpc.invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V2, request);
      await vi.waitFor(async () => {
        expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V2, {
          handoffId: request.handoffId, sessionId: request.sessionId,
        })).toMatchObject({ remoteSessionId: 'native-1', status: { status: 'ready_for_cutover' } });
      }, { timeout: 10_000 });
      expect(await readFile(transcriptPath, 'utf8')).toBe(transcript);
    } finally {
      accountLookup.mockRestore();
      env.restore();
      reloadConfiguration();
      await rm(root, { recursive: true, force: true });
    }
  });
});
