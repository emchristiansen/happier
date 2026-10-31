import { createCatalogCliAuthSpec } from '@/capabilities/cliAuth/createCatalogCliAuthSpec';
import { runCliCommandBestEffort } from '@/capabilities/cliAuth/shared';

function readAccountLabel(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    for (const key of ['email', 'accountEmail', 'username']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  } catch {
    // A successful status command is still authoritative when an older CLI emits human text.
  }
  return null;
}

export const auggieCliAuthSpec = createCatalogCliAuthSpec('auggie', {
  detectAuthStatus: async ({ resolvedPath }) => {
    const result = await runCliCommandBestEffort({
      resolvedPath,
      args: ['account', 'status', '--json'],
      timeoutMs: 2_000,
    });
    const output = `${result.stdout}\n${result.stderr}`.trim();

    if (result.ok) {
      const accountLabel = readAccountLabel(result.stdout);
      return {
        state: 'logged_in',
        method: 'oauth_cli',
        ...(accountLabel ? { accountLabel } : {}),
        source: 'command',
      };
    }
    if (/not currently logged in|run ['"]?auggie login/iu.test(output)) {
      return { state: 'logged_out', reason: 'missing_credentials', source: 'command' };
    }
    return { state: 'unknown', reason: 'probe_failed', source: 'command' };
  },
});
