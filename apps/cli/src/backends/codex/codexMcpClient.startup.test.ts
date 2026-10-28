import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';
import { writeFakeCodexAppServerScript } from './appServer/testkit/fakeCodexAppServer';
import { CodexMcpClient } from './codexMcpClient';

describe('CodexMcpClient native startup', () => {
  it('serializes native MCP initialization without waiting for the first session to disconnect', async () => {
    await withTempDir('happier-codex-mcp-native-startup-', async root => {
      await mkdir(join(root, 'shared-home'));
      // Native subprocess protocol boundary; SDK transport and internal client remain real.
      const executable = await writeFakeCodexAppServerScript({
        dir: root,
        importLines: ['import { mkdir, rm } from "node:fs/promises";', 'import { join } from "node:path";'],
        setupLines: ['const guard = join(process.env.CODEX_HOME, "native-startup");'],
        bodyLines: [
          'for await (const line of rl) {',
          '  if (!line.trim()) continue;',
          '  const request = JSON.parse(line);',
          '  if (request.method !== "initialize") continue;',
          '  try { await mkdir(guard); } catch (error) {',
          '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: error.code } }) + "\\n");',
          '    continue;',
          '  }',
          '  await new Promise(resolve => setTimeout(resolve, 100));',
          '  await rm(guard, { recursive: true });',
          '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "0.160.0" } } }) + "\\n");',
          '}',
        ],
      });
      const clients = [0, 1].map(() => new CodexMcpClient({
        command: process.execPath, mode: 'mcp-server', args: [executable], env: { CODEX_HOME: join(root, 'shared-home') },
      }));
      try {
        const outcomes = await Promise.allSettled(clients.map(client => client.connect()));
        expect(outcomes).toEqual([{ status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: undefined }]);
      } finally {
        await Promise.all(clients.map(client => client.disconnect()));
      }
    });
  });
});
