import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { writeKimiFixture } from '../cli/runtimeDiscovery.testkit';
import { createKimiBackend } from './backend';
import type { AgentMessage } from '@/agent/core';
import { AcpBackend } from '@/agent/acp/AcpBackend';
import { getExecutionRunBackendFactory } from '@/agent/executionRuns/registry/executionRunBackendRegistry';

describe.skipIf(process.platform === 'win32')('Kimi ACP backend', () => {
  it('classifies the executable then creates and resumes with plain acp and MCP', async () => {
    await withTempDir('happier-kimi-backend-', async (dir) => {
      const physicalDir = realpathSync(dir);
      const command = writeKimiFixture(dir, 'current');
      const options = {
        cwd: dir, env: { HAPPIER_KIMI_PATH: command }, permissionMode: 'yolo' as const,
        mcpServers: { happier: { command: '/bin/echo', args: ['noop'] } },
      };
      const fresh = createKimiBackend(options);
      const events: AgentMessage[] = [];
      fresh.onMessage((event) => events.push(event));
      try {
        expect(await fresh.startSession()).toMatchObject({ sessionId: 'kimi-fixture-session' });
        expect(events.some((event) => event.type === 'event' && event.name === 'session_modes_state')).toBe(false);
        expect(events.filter((event) => event.type === 'event' && event.name === 'config_options_state'))
          .toEqual([expect.objectContaining({ payload: { configOptions: [expect.objectContaining({ id: 'model' })] } })]);
      } finally { await fresh.dispose(); }
      const resumed = createKimiBackend(options);
      try {
        expect(await resumed.loadSession?.('kimi-fixture-session')).toMatchObject({ sessionId: 'kimi-fixture-session' });
      } finally { await resumed.dispose(); }
      const requests = readFileSync(join(dir, 'requests.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(requests.filter((request) => ['session/new', 'session/load'].includes(request.method))).toEqual([
        expect.objectContaining({ method: 'session/new', cwd: physicalDir, args: ['acp'], params: expect.objectContaining({ mcpServers: [expect.objectContaining({ name: 'happier', command: '/bin/echo' })] }) }),
        expect.objectContaining({ method: 'session/load', cwd: physicalDir, args: ['acp'], params: expect.objectContaining({ sessionId: 'kimi-fixture-session', mcpServers: [expect.objectContaining({ name: 'happier' })] }) }),
      ]);
      expect(requests.some((request) => request.method === 'session/set_mode')).toBe(false);
      const forked = createKimiBackend(options);
      try {
        if (!(forked instanceof AcpBackend)) throw new Error('Expected shared ACP backend');
        expect(await forked.forkSession({ sessionId: 'kimi-fixture-session' }))
          .toMatchObject({ sessionId: 'kimi-fixture-fork' });
      } finally { await forked.dispose(); }
      const executionRunBackendFactory = getExecutionRunBackendFactory('kimi');
      if (!executionRunBackendFactory) throw new Error('Expected Kimi execution-run backend factory');
      const executionRun = executionRunBackendFactory({
        backendId: 'kimi', cwd: dir, modelId: 'kimi-for-coding', permissionMode: 'default',
        permissionHandler: { handleToolCall: async () => ({ decision: 'denied' }) },
        isolation: { env: { HAPPIER_KIMI_PATH: command } },
      });
      try {
        expect(await executionRun.startSession()).toMatchObject({ sessionId: 'kimi-fixture-session' });
      } finally { await executionRun.dispose(); }
      const executionRunRequests = readFileSync(join(dir, 'requests.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(executionRunRequests).toContainEqual(expect.objectContaining({
        method: 'session/set_config_option',
        params: expect.objectContaining({ sessionId: 'kimi-fixture-session', configId: 'model', value: 'kimi-for-coding' }),
      }));
      expect(executionRunRequests.some((request) => request.method === 'session/set_model')).toBe(false);
    });
  });
});
