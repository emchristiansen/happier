import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createExecutableShim } from '@/testkit/fs/executableShim';
import { removeTempDir, withTempDir } from '@/testkit/fs/tempDir';
import { createCodexAcpBackend } from './backend';

describe('Codex ACP native startup', () => {
  it('serializes the actual native spawn and initialize without holding ongoing sessions', async () => {
    await withTempDir('happier-codex-acp-native-startup-', async root => {
      await mkdir(join(root, 'shared-home'));
      const executable = writeAcpTestAgentScript({
        dir: root,
        fileName: 'native-startup.cjs',
        source: `
          const fs = require('node:fs');
          const path = require('node:path');
          const readline = require('node:readline');
          const guard = path.join(process.env.CODEX_HOME, 'native-startup');
          fs.mkdirSync(guard);
          const lines = readline.createInterface({ input: process.stdin });
          const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
          lines.on('line', async line => {
            const request = JSON.parse(line);
            if (request.method === 'initialize') {
              await new Promise(resolve => setTimeout(resolve, 100));
              fs.rmSync(guard, { recursive: true });
              send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentCapabilities: {} } });
            } else if (request.method === 'session/new') {
              send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'fixture-session' } });
            }
          });
        `,
      });
      const wrapper = await createExecutableShim({
        dirPrefix: 'happier-codex-acp-startup-bin-',
        fileName: process.platform === 'win32' ? 'codex-acp.cmd' : 'codex-acp',
        contents: process.platform === 'win32'
          ? `@echo off\r\n"${process.execPath}" "${executable}"\r\n`
          : `#!/bin/sh\nexec "${process.execPath}" "${executable}"\n`,
      });
      const backends = [0, 1].map(() => createCodexAcpBackend({
        cwd: root,
        env: { HAPPIER_CODEX_ACP_BIN: wrapper, CODEX_HOME: join(root, 'shared-home'), OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined },
      }).backend);
      try {
        const outcomes = await Promise.allSettled(backends.map(backend => backend.startSession()));
        expect(outcomes).toEqual([
          { status: 'fulfilled', value: { sessionId: 'fixture-session' } },
          { status: 'fulfilled', value: { sessionId: 'fixture-session' } },
        ]);
      } finally {
        await Promise.all(backends.map(backend => backend.dispose()));
        await removeTempDir(dirname(wrapper));
      }
    });
  });
});
