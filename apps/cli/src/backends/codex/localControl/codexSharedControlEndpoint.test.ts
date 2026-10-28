import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  readCodexSharedControlEndpoint,
  removeCodexSharedControlEndpoint,
  writeCodexSharedControlEndpoint,
} from './codexSharedControlEndpoint';

describe('codexSharedControlEndpoint', () => {
  it('publishes the private endpoint for the matching Happier session', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-codex-shared-endpoint-'));

    await writeCodexSharedControlEndpoint({
      happyHomeDir,
      sessionId: 'session/with-special-characters',
      endpoint: 'unix:///tmp/happier-codex/private/app-server.sock',
    });

    await expect(readCodexSharedControlEndpoint({
      happyHomeDir,
      sessionId: 'session/with-special-characters',
    })).resolves.toMatchObject({
      version: 1,
      sessionId: 'session/with-special-characters',
      endpoint: 'unix:///tmp/happier-codex/private/app-server.sock',
    });
  });

  it('does not let stale cleanup remove a replacement endpoint', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-codex-shared-endpoint-'));
    const sessionId = 'session-1';
    await writeCodexSharedControlEndpoint({ happyHomeDir, sessionId, endpoint: 'unix:///tmp/old.sock' });
    await writeCodexSharedControlEndpoint({ happyHomeDir, sessionId, endpoint: 'unix:///tmp/new.sock' });

    await expect(removeCodexSharedControlEndpoint({
      happyHomeDir,
      sessionId,
      expectedEndpoint: 'unix:///tmp/old.sock',
    })).resolves.toBe(false);
    await expect(readCodexSharedControlEndpoint({ happyHomeDir, sessionId })).resolves.toMatchObject({
      endpoint: 'unix:///tmp/new.sock',
    });
    await expect(removeCodexSharedControlEndpoint({
      happyHomeDir,
      sessionId,
      expectedEndpoint: 'unix:///tmp/new.sock',
    })).resolves.toBe(true);
    await expect(readCodexSharedControlEndpoint({ happyHomeDir, sessionId })).resolves.toBeNull();
  });
});
