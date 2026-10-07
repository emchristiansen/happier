import { isOpenCodeServerReadyResponse, OPEN_CODE_AUTO_READINESS_PATHS, OPEN_CODE_V2_READINESS_PATHS } from './openCodeServerReadiness';

export async function waitForOpenCodeServerHealth(params: {
  baseUrl: string;
  timeoutMs: number;
  pollIntervalMs: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Released V2 may require a different Basic username from retained V1/reverse-proxy auth. */
  v2Headers?: Record<string, string>;
  apiGeneration?: 'auto' | 'v2';
  onReady?: (apiGeneration: 'auto' | 'v2') => void;
}): Promise<void> {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    if (params.signal?.aborted) throw new Error('Aborted while waiting for OpenCode server health');
    try {
      const request = async (path: string): Promise<Response | null> => {
        const ctrl = new AbortController();
        const onAbort = () => ctrl.abort();
        params.signal?.addEventListener('abort', onAbort, { once: true });
        const requestTimeoutMs = Math.min(
          1_500,
          params.pollIntervalMs * 5,
          Math.max(1, deadline - Date.now()),
        );
        const timer = setTimeout(() => ctrl.abort(), requestTimeoutMs);
        timer.unref?.();
        try {
          const headers = path.startsWith('/api/') ? params.v2Headers ?? params.headers : params.headers;
          return await fetch(`${params.baseUrl}${path}`, {
            signal: ctrl.signal,
            ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
          }).catch(() => null);
        } finally {
          clearTimeout(timer);
          params.signal?.removeEventListener('abort', onAbort);
        }
      };
      const isHealthy = async (path: string, response: Response | null): Promise<boolean> => {
        if (!response?.ok) return false;
        const body = await response.json().catch(() => null) as unknown;
        return isOpenCodeServerReadyResponse(path, body);
      };
      const paths = params.apiGeneration === 'v2'
          ? OPEN_CODE_V2_READINESS_PATHS
          : OPEN_CODE_AUTO_READINESS_PATHS;
      let healthy = false;
      for (const path of paths) {
        if (await isHealthy(path, await request(path))) {
          healthy = true;
          params.onReady?.(path.startsWith('/api/') ? 'v2' : 'auto');
          break;
        }
      }
      if (healthy) return;
    } catch {
      // ignore and retry until deadline
    }
    await new Promise((r) => setTimeout(r, params.pollIntervalMs));
  }
  throw new Error(`Timed out waiting for OpenCode server health after ${params.timeoutMs}ms`);
}
