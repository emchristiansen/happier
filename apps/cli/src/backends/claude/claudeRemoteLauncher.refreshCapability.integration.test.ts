import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createDeferred } from '@/testkit/async/deferred';
import type { EnhancedMode } from './loop';
import { hashClaudeEnhancedModeForQueue } from './remote/modeHash';
import { Session } from './session';

const { query, notifyDaemon } = vi.hoisted(() => ({
  query: vi.fn(),
  notifyDaemon: vi.fn(async () => ({ success: true })),
}));

// Substitute the external SDK and daemon transport; launcher, dispatch and runner stay real.
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>(),
  query,
}));
vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  notifyDaemonSessionStarted: notifyDaemon,
}));
vi.mock('@/runtime/js/ensureJavaScriptRuntimeExecutable', () => ({
  ensureJavaScriptRuntimeExecutable: vi.fn(async () => process.execPath),
}));

const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'CLAUDE_CONFIG_DIR', 'HAPPIER_CLAUDE_PATH']);
afterEach(() => { env.restore(); vi.clearAllMocks(); });

describe('Claude launcher refresh capability', () => {
  it('reports unavailable at the daemon boundary while running the Agent SDK', async () => {
    await withTempDir('claude-refresh-capability-', async (dir) => {
      const cli = join(dir, 'claude.js');
      await writeFile(cli, '// SDK boundary fixture; never executed\n');
      const transcript = join(dir, 'claude-refresh-session.jsonl');
      await writeFile(transcript, '{"type":"summary"}\n');
      env.patch({ HAPPIER_HOME_DIR: dir, CLAUDE_CONFIG_DIR: dir, HAPPIER_CLAUDE_PATH: cli });
      const enteredSdk = createDeferred<void>();
      const finishSdk = createDeferred<void>();
      query.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {
          enteredSdk.resolve();
          await finishSdk.promise;
        },
        close: () => finishSdk.resolve(),
        supportedCommands: async () => [],
        supportedModels: async () => [],
      }));
      const client = createMutableApiSessionClientFixture({
        metadata: createTestMetadata({ path: dir, homeDir: dir, happyHomeDir: dir, flavor: 'claude' }),
        overrides: {
          sessionId: 'happier-refresh-session',
          getAgentStateSnapshot: () => ({ requests: {}, completedRequests: {} }),
          updateAgentState: vi.fn(),
          sendSessionEvent: vi.fn(),
          sendClaudeSessionMessage: vi.fn(),
          flush: vi.fn(async () => {}),
          shouldAttemptPendingMaterialization: () => false,
        },
      });
      const queue = new MessageQueue2<EnhancedMode>(hashClaudeEnhancedModeForQueue);
      const session = new Session({
        client,
        path: dir,
        logPath: join(dir, 'session.log'),
        sessionId: 'claude-refresh-session',
        messageQueue: queue,
        onModeChange: () => {},
        hookSettingsPath: join(dir, 'hooks.json'),
        precomputedMcpBridge: { mcpServers: {}, stop: () => {} },
      });
      session.transcriptPath = transcript;
      queue.push('hello', {
        permissionMode: 'default',
        claudeRemoteAgentSdkEnabled: true,
        claudeUnifiedTerminalEnabled: false,
      }, { userMessageLocalId: 'refresh-capability-prompt' });
      const sdkBoundary = await import('@anthropic-ai/claude-agent-sdk');
      const daemonBoundary = await import('@/daemon/controlClient');
      expect(sdkBoundary.query).toBe(query);
      expect(vi.isMockFunction(sdkBoundary.query)).toBe(true);
      expect(daemonBoundary.notifyDaemonSessionStarted).toBe(notifyDaemon);
      expect(vi.isMockFunction(daemonBoundary.notifyDaemonSessionStarted)).toBe(true);
      const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
      const launch = claudeRemoteLauncher(session);
      try {
        // A startup rejection must fail the test rather than leave a pending readiness wait.
        await Promise.race([enteredSdk.promise, launch.then(() => { throw new Error('Launcher exited before SDK query'); })]);
        expect(notifyDaemon.mock.calls).toContainEqual(['happier-refresh-session', expect.objectContaining({
            claudeSubscriptionAccessTokenRefreshV1: { v: 1, mode: 'unavailable' },
        }), expect.any(Object)]);
      } finally {
        queue.close();
        finishSdk.resolve();
        try { await launch; } finally { session.cleanup(); }
      }
    });
  });
});
