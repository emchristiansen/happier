import { createCatalogCliAuthSpec } from '@/capabilities/cliAuth/createCatalogCliAuthSpec';
import { runCliCommandBestEffort } from '@/capabilities/cliAuth/shared';

function readCount(output: string, pattern: RegExp): number | null {
  const match = pattern.exec(output);
  return match ? Number(match[1] ?? 0) : null;
}

export const kiloCliAuthSpec = createCatalogCliAuthSpec('kilo', {
  detectAuthStatus: async ({ resolvedPath }) => {
    const result = await runCliCommandBestEffort({
      resolvedPath,
      args: ['auth', 'list'],
      timeoutMs: 2_000,
    });
    if (!result.ok) {
      return { state: 'unknown', reason: 'probe_failed', source: 'command' };
    }

    const output = `${result.stdout}\n${result.stderr}`;
    const storedCredentialCount = readCount(output, /(\d+)\s+credentials?\b/iu);
    const environmentCredentialCount = readCount(output, /(\d+)\s+environment variables?\b/iu) ?? 0;
    if (storedCredentialCount === null) {
      return { state: 'unknown', reason: 'probe_failed', source: 'command' };
    }
    if (storedCredentialCount === 0 && environmentCredentialCount === 0) {
      return { state: 'logged_out', reason: 'missing_credentials', source: 'command' };
    }
    return {
      state: 'logged_in',
      method: storedCredentialCount > 0 ? 'credentials_file' : 'api_key_env',
      source: 'command',
    };
  },
});
