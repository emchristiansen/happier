import { describe, expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';
import { writeExecutableShim } from '@/testkit/fs/executableShim';

import { auggieCliAuthSpec } from './auggieCliAuthSpec';

describe('auggieCliAuthSpec', () => {
  it('reports authenticated account status from the provider command', async () => {
    await withTempDir('happier-auggie-auth-', async (dir) => {
      const executable = await writeExecutableShim({
        dir,
        fileName: process.platform === 'win32' ? 'auggie.cmd' : 'auggie',
        contents: process.platform === 'win32'
          ? '@echo off\r\necho {"email":"user@example.com"}\r\nexit /b 0\r\n'
          : '#!/bin/sh\nprintf \'%s\\n\' \'{"email":"user@example.com"}\'\n',
      });

      await expect(auggieCliAuthSpec.detectAuthStatus?.({ resolvedPath: executable })).resolves.toEqual({
        state: 'logged_in',
        method: 'oauth_cli',
        accountLabel: 'user@example.com',
        source: 'command',
      });
    });
  });

  it('reports the provider explicit logged-out response', async () => {
    await withTempDir('happier-auggie-auth-', async (dir) => {
      const executable = await writeExecutableShim({
        dir,
        fileName: process.platform === 'win32' ? 'auggie.cmd' : 'auggie',
        contents: process.platform === 'win32'
          ? '@echo off\r\necho You are not currently logged in to Augment. 1>&2\r\nexit /b 1\r\n'
          : '#!/bin/sh\necho "You are not currently logged in to Augment." >&2\nexit 1\n',
      });

      await expect(auggieCliAuthSpec.detectAuthStatus?.({ resolvedPath: executable })).resolves.toEqual({
        state: 'logged_out',
        reason: 'missing_credentials',
        source: 'command',
      });
    });
  });
});
