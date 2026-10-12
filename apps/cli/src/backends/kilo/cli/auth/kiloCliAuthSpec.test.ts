import { describe, expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';
import { writeExecutableShim } from '@/testkit/fs/executableShim';

import { kiloCliAuthSpec } from './kiloCliAuthSpec';

async function writeKiloAuthListShim(dir: string, output: string): Promise<string> {
  return await writeExecutableShim({
    dir,
    fileName: process.platform === 'win32' ? 'kilo.cmd' : 'kilo',
    contents: process.platform === 'win32'
      ? `@echo off\r\necho ${output}\r\nexit /b 0\r\n`
      : `#!/bin/sh\nprintf '%s\\n' '${output}'\n`,
  });
}

describe('kiloCliAuthSpec', () => {
  it('reports configured credentials from kilo auth list', async () => {
    await withTempDir('happier-kilo-auth-', async (dir) => {
      const executable = await writeKiloAuthListShim(dir, '2 credentials');
      await expect(kiloCliAuthSpec.detectAuthStatus?.({ resolvedPath: executable })).resolves.toEqual({
        state: 'logged_in',
        method: 'credentials_file',
        source: 'command',
      });
    });
  });

  it('distinguishes provider environment credentials from stored credentials', async () => {
    await withTempDir('happier-kilo-auth-', async (dir) => {
      const executable = await writeKiloAuthListShim(dir, '0 credentials\n1 environment variable');
      await expect(kiloCliAuthSpec.detectAuthStatus?.({ resolvedPath: executable })).resolves.toEqual({
        state: 'logged_in',
        method: 'api_key_env',
        source: 'command',
      });
    });
  });

  it('reports logged out when neither credentials nor provider environment variables exist', async () => {
    await withTempDir('happier-kilo-auth-', async (dir) => {
      const executable = await writeKiloAuthListShim(dir, '0 credentials');
      await expect(kiloCliAuthSpec.detectAuthStatus?.({ resolvedPath: executable })).resolves.toEqual({
        state: 'logged_out',
        reason: 'missing_credentials',
        source: 'command',
      });
    });
  });
});
