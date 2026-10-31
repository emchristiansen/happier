import { describe, expect, it } from 'vitest';

import { createCodexSharedAttachArgs } from './createCodexSharedAttachArgs';

describe('createCodexSharedAttachArgs', () => {
  it('attaches the native TUI to the existing app-server thread', () => {
    expect(createCodexSharedAttachArgs({
      endpoint: 'unix:///tmp/happier-codex/app-server.sock',
      directory: '/workspace',
      sessionId: 'thread-1',
    })).toEqual([
      '--remote', 'unix:///tmp/happier-codex/app-server.sock',
      '--cd', '/workspace',
      'resume', 'thread-1',
    ]);
  });
});
