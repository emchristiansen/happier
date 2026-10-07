import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import { readFile, rmdir, unlink } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ socketPath: '', startedServers: [] as string[] }));
// Only OS process discovery/startup is replaced; host selection, recovery and socket transport stay real.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
  ...actual,
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: async (binary: string, args: string[]) => ({
      stdout: args.includes('list')
        ? JSON.stringify({ sessions: ['default', 'work', ...boundary.startedServers].map((name) => ({ name, socket_path: boundary.socketPath, running: true })) })
        : binary === process.execPath ? process.version : 'herdr 0.9.2',
      stderr: '',
    }),
  }),
  spawn: vi.fn((binary: string, args: string[], options: import('node:child_process').SpawnOptions) => {
    if (!args.includes('server')) return actual.spawn(binary, args, options);
    boundary.startedServers.push(args[0] === '--session' ? args[1]! : 'default');
    return Object.assign(new EventEmitter(), { unref() {} });
  }),
  };
});

import { configuration } from '@/configuration';
import { withHerdrApi } from '@/integrations/herdr/herdrApi.testkit';
import { readTerminalAttachmentInfo, removeTerminalAttachmentInfo, writeTerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import type { TerminalHostHandle, TerminalAttachmentId } from '@/integrations/terminalHost/_types';
import { runClaudeUnifiedTerminalSession } from './runClaudeUnifiedTerminalSession';

describe('Claude unified Herdr grouping', () => {
  it.skipIf(process.platform === 'win32').each([
    { sessionId: 'herdr-group-fresh', recordedServer: null, expectedServer: 'default' },
    { sessionId: 'herdr-group-recovery', recordedServer: 'work', expectedServer: 'work' },
  ])('creates in $expectedServer rather than the generated agent label', async ({ sessionId, recordedServer, expectedServer }) => {
    await withHerdrApi(async (api) => {
      boundary.socketPath = api.socketPath;
      boundary.startedServers.length = 0;
      vi.stubEnv('HAPPIER_CLAUDE_PATH', process.execPath);
      const abort = new AbortController();
      if (recordedServer) {
        const attachmentId = 'recorded-herdr-group' as TerminalAttachmentId;
        const handle: TerminalHostHandle = {
          attachmentId, kind: 'herdr', sessionName: recordedServer,
          socketPath: api.socketPath, terminalId: 'confirmed-dead-terminal', paneId: 'old-pane',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
        };
        await writeTerminalAttachmentInfo({
          happyHomeDir: configuration.happyHomeDir, sessionId, attachmentId, handle,
          terminal: { mode: 'herdr', herdr: { sessionName: recordedServer, socketPath: api.socketPath, terminalId: handle.terminalId! } },
        });
      }
      try {
        await runClaudeUnifiedTerminalSession({
          path: tmpdir(), happySessionId: sessionId,
          initialMode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'herdr' },
          nextMessage: async () => null, signal: abort.signal, processSignals: null,
          onTerminalHostReady: () => { abort.abort(); },
        });
        const saved = await readTerminalAttachmentInfo({ happyHomeDir: configuration.happyHomeDir, sessionId });
        expect(saved?.terminal).toMatchObject({ mode: 'herdr', herdr: { sessionName: expectedServer, socketPath: api.socketPath } });
        expect(boundary.startedServers).toEqual([]);
        const layout = api.requests.find((request) => request.method === 'layout.apply');
        expect(layout?.params.tab_label).toMatch(/^happier-claude-unified-/);
      } finally {
        await removeTerminalAttachmentInfo({ happyHomeDir: configuration.happyHomeDir, sessionId });
        for (const request of api.requests.filter((request) => request.method === 'layout.apply')) {
          const root = request.params.root as { command?: string[] };
          const specPath = root.command?.[2];
          if (specPath) {
            const spec: { args?: string[] } = JSON.parse(await readFile(specPath, 'utf8'));
            const innerSpecPath = spec.args?.[1];
            if (innerSpecPath && dirname(dirname(innerSpecPath)) === tmpdir()
              && basename(dirname(innerSpecPath)).startsWith('happier-terminal-launch-')
              && basename(innerSpecPath) === 'launch.json') {
              await unlink(innerSpecPath).catch(() => {});
              await rmdir(dirname(innerSpecPath)).catch(() => {});
            }
            await unlink(specPath).catch(() => {});
            await rmdir(dirname(specPath)).catch(() => {});
          }
        }
        vi.unstubAllEnvs();
      }
    });
  });
});
