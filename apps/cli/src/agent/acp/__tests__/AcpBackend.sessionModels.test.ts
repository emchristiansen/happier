import { describe, expect, it } from 'vitest';

import { probeModelsFromAcpBackend } from '@/capabilities/probes/agentModelsProbe';

import { AcpBackend } from '../AcpBackend';
import { writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import type { AgentMessage } from '../../core/AgentMessage';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createTestAcpRuntime } from '@/testkit/backends/acpRuntime';
import { createSessionClientWithMetadata } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

function writeFakeAcpAgentScript(params: { dir: string; emptyModels?: boolean; emptyModelChoices?: boolean; emitModelUpdates?: boolean }): string {
  const src = `
    const decoder = new TextDecoder();
    let buf = '';

    function send(obj) {
      process.stdout.write(JSON.stringify(obj) + '\\n');
    }

    function ok(id, result) {
      if (${params.emptyModels === true} && result.models) result.models.availableModels = [];
      if (${params.emptyModelChoices === true} && result.models) {
        result.configOptions = [{ id: 'model', name: 'Model', type: 'select', currentValue: 'model-a', options: [] }];
        delete result.models;
      }
      send({ jsonrpc: '2.0', id, result });
    }

    process.stdin.on('data', (chunk) => {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let req;
        try { req = JSON.parse(trimmed); } catch { continue; }
        if (!req || typeof req !== 'object') continue;
        const id = req.id;
        const method = req.method;
        if (id === undefined || id === null || typeof method !== 'string') continue;

        if (method === 'initialize') {
          ok(id, { protocolVersion: 1, authMethods: [] });
          continue;
        }

        if (method === 'session/new') {
          ok(id, {
            sessionId: 'test-session',
            models: {
              currentModelId: 'model-a',
              availableModels: [
                {
                  id: 'model-a',
                  name: 'Model A',
                  description: 'Fast',
                  modelOptions: [
                    {
                      id: 'reasoning_effort',
                      name: 'Thinking',
                      type: 'select',
                      currentValue: 'medium',
                      options: [
                        { value: 'medium', name: 'Medium' },
                        { value: 'high', name: 'High', description: 'More depth' },
                      ],
                    },
                    {
                      id: 'service_tier',
                      name: 'Speed',
                      type: 'select',
                      currentValue: 'fast',
                      options: [
                        { value: 'standard', name: 'Standard' },
                        { value: 'fast', name: 'Fast' },
                      ],
                    },
                  ],
                },
                { id: 'model-b', name: 'Model B', description: 'Accurate' },
              ],
            },
          });
          continue;
        }

        if (method === 'session/set_model') {
          if (${params.emitModelUpdates === true}) send({
            jsonrpc: '2.0', method: 'session/update', params: {
              sessionId: 'test-session',
              update: { sessionUpdate: 'current_model_update', currentModelId: req.params.modelId },
            },
          });
          ok(id, {});
          continue;
        }

        ok(id, {});
      }
    });
  `;

  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: 'fake-acp-agent.mjs',
    source: src,
  });
}

describe('AcpBackend session models', () => {
  it('reports successful empty config model choices through preflight', async () => {
    await withTempDir('happier-acp-empty-config-probe-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({ dir, emptyModelChoices: true });
      const backend = new AcpBackend({ agentName: 'test', cwd: dir, command: process.execPath, args: [scriptPath] });
      try {
        expect(await probeModelsFromAcpBackend({ backend, timeoutMs: 10_000 })).toEqual([{ id: 'default', name: 'Default' }]);
      } finally { await backend.dispose(); }
    });
  });

  it.each(['empty', 'empty_config_options', 'current_model_update'] as const)('publishes %s through the real ACP transport and runtime', async (observation) => {
    await withTempDir('happier-acp-model-observation-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({ dir, emptyModels: observation === 'empty', emptyModelChoices: observation === 'empty_config_options', emitModelUpdates: true });
      const backend = new AcpBackend({ agentName: 'test', cwd: dir, command: process.execPath, args: [scriptPath] });
      const { session, getMetadata } = createSessionClientWithMetadata({ initialMetadata: createTestMetadata({
        sessionModelsV1: {
          v: 1, provider: 'grok', updatedAt: 1, currentModelId: 'old',
          availableModels: [{ id: 'old', name: 'Old' }],
        },
      }) });
      const runtime = createTestAcpRuntime({
        provider: 'grok', directory: dir, session, messageBuffer: new MessageBuffer(),
        mcpServers: {}, permissionHandler: createApprovedPermissionHandler(),
        onThinkingChange: () => {}, ensureBackend: async () => backend,
      });
      try {
        await runtime.startOrLoad({});
        if (observation !== 'current_model_update') {
          expect(getMetadata().sessionModelsV1).toMatchObject({ currentModelId: 'model-a', availableModels: [] });
        } else {
          const catalogObservedAt = getMetadata().sessionModelsV1?.updatedAt;
          await runtime.setSessionModel('model-b');
          await expect.poll(() => getMetadata().sessionModelsV1?.currentModelId).toBe('model-b');
          expect(getMetadata().sessionModelsV1?.updatedAt).toBe(catalogObservedAt);
          expect(getMetadata().sessionModelsV1?.availableModels.map((model) => model.id)).toEqual(['model-a', 'model-b']);
        }
        expect(getMetadata().sessionModelsV1).toEqual(getMetadata().acpSessionModelsV1);
      } finally { await runtime.reset(); }
    });
  });

  it('captures models from newSession and can set the current model', async () => {
    await withTempDir('happier-acp-models-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({ dir });

      let backend: AcpBackend | null = null;
      try {
        backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
        });

        const events: AgentMessage[] = [];
        backend.onMessage((msg) => {
          if (msg.type === 'event') events.push(msg);
        });

        const started = await backend.startSession();
        expect(started.sessionId).toBe('test-session');

        const models = (backend as any).getSessionModelState?.();
        expect(models).toEqual({
          currentModelId: 'model-a',
          availableModels: [
            {
              id: 'model-a',
              name: 'Model A',
              description: 'Fast',
              modelOptions: [
                {
                  id: 'reasoning_effort',
                  name: 'Thinking',
                  type: 'select',
                  currentValue: 'medium',
                  options: [
                    { value: 'medium', name: 'Medium' },
                    { value: 'high', name: 'High', description: 'More depth' },
                  ],
                },
                {
                  id: 'service_tier',
                  name: 'Speed',
                  type: 'select',
                  currentValue: 'fast',
                  options: [
                    { value: 'standard', name: 'Standard' },
                    { value: 'fast', name: 'Fast' },
                  ],
                },
              ],
            },
            { id: 'model-b', name: 'Model B', description: 'Accurate' },
          ],
        });

        expect(events.some((e) => e.type === 'event' && e.name === 'session_models_state')).toBe(true);

        await (backend as any).setSessionModel(started.sessionId, 'model-b');
        const after = (backend as any).getSessionModelState?.();
        expect(after?.currentModelId).toBe('model-b');

        expect(events.some((e) => e.type === 'event' && e.name === 'current_model_update')).toBe(true);
      } finally {
        try {
          await backend?.dispose();
        } catch {}
      }
    });
  });

  it('rejects setSessionModel when sessionId does not match the active ACP session', async () => {
    await withTempDir('happier-acp-models-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({ dir });

      let backend: AcpBackend | null = null;
      try {
        backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
        });

        const started = await backend.startSession();
        expect(started.sessionId).toBe('test-session');

        await expect((backend as any).setSessionModel('not-the-session', 'model-b')).rejects.toThrow(
          /Session ID does not match the active ACP session/,
        );
      } finally {
        try {
          await backend?.dispose();
        } catch {}
      }
    });
  });
});
