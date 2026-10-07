import { describe, expect, it } from 'vitest';

import { writeFakeCodexAppServerThreadListScript } from '../testkit/fakeCodexAppServer';
import { withTempDir } from '@/testkit/fs/tempDir';

import { isCodexThreadLoadedInAppServerDaemon } from './codexAppServerDaemonTransport';

describe('codexAppServerDaemonTransport', () => {
  it('reports only thread ids loaded by the existing Codex daemon', async () => {
    await withTempDir('happier-codex-daemon-transport-', async (root) => {
      const fakeAppServer = await writeFakeCodexAppServerThreadListScript({
        dir: root,
        loadedThreadIds: ['loaded-thread'],
      });
      const processEnv = {
        ...process.env,
        HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
      };

      await expect(isCodexThreadLoadedInAppServerDaemon({
        cwd: root,
        processEnv,
        threadId: 'loaded-thread',
      })).resolves.toBe(true);
      await expect(isCodexThreadLoadedInAppServerDaemon({
        cwd: root,
        processEnv,
        threadId: 'idle-thread',
      })).resolves.toBe(false);
    });
  });
});
