import { isOpenCodeServerReadyResponse } from '@/backends/opencode/server/openCodeServerReadiness';

/**
 * CLI dialect used to attach an interactive OpenCode terminal to an already running server.
 *
 * - `v1` (retained line): `opencode attach <url> --dir <dir> --session <id>`.
 * - `v2` (released OpenCode 2): there is no `attach` subcommand and no `--dir` flag anywhere in the
 *   2.0.15 CLI (`packages/cli/src/commands/commands.ts` @ 6f3639d). The root command owns it instead:
 *   `--server <url>` selects the server (authenticating with `OPENCODE_PASSWORD`, see
 *   `services/server-connection.ts`), `--session <id>` continues the session, and the optional
 *   positional directory is `process.chdir`-ed by the root handler (`handlers/default.ts`).
 */
export type OpenCodeAttachCliDialect = 'v1' | 'v2';

/**
 * Resolve the dialect from the ACTUAL target rather than the executable name: released OpenCode 2 and
 * the retained line share the `opencode` name, so only an explicit generation selection or the
 * server's own readiness surface can decide. `/api/info` with the released info shape is v2-only;
 * `/global/health` is the retained line's surface.
 *
 * A dialect is returned only after a positive authenticated readiness response. Treating an
 * unreachable, unauthorized, or unrecognized target as V1 would invent a contract and launch the
 * wrong argv shape against released V2.
 */
export async function resolveOpenCodeAttachCliDialect(params: Readonly<{
  baseUrl: string;
  launchApiGeneration?: 'auto' | 'v2';
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}>): Promise<OpenCodeAttachCliDialect> {
  if (params.launchApiGeneration === 'v2') return 'v2';

  const fetchFn = params.fetchFn ?? fetch;
  const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 1_500;
  const baseUrl = params.baseUrl.replace(/\/+$/u, '');
  const probe = async (path: string): Promise<boolean> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchFn(`${baseUrl}${path}`, {
        method: 'GET',
        signal: ctrl.signal,
        ...(params.headers && Object.keys(params.headers).length > 0 ? { headers: params.headers } : {}),
      }).catch(() => null);
      if (!response?.ok) return false;
      const body = await response.json().catch(() => null) as unknown;
      return isOpenCodeServerReadyResponse(path, body);
    } finally {
      clearTimeout(timer);
    }
  };

  if (await probe('/api/info')) return 'v2';
  if (await probe('/global/health')) return 'v1';
  throw new Error(
    'OpenCode server generation detection failed: neither authenticated V2 nor V1 health contract is available',
  );
}
