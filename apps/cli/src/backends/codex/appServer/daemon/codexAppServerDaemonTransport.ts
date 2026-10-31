import { createCodexAppServerClient } from '../client/createCodexAppServerClient';

export const CODEX_APP_SERVER_TRANSPORT_ENV_KEY = 'HAPPIER_CODEX_APP_SERVER_TRANSPORT';
export const CODEX_APP_SERVER_DAEMON_PROXY_TRANSPORT = 'daemonProxy';

export function shouldUseCodexAppServerDaemonProxy(env: NodeJS.ProcessEnv): boolean {
  return env[CODEX_APP_SERVER_TRANSPORT_ENV_KEY] === CODEX_APP_SERVER_DAEMON_PROXY_TRANSPORT;
}

export async function createCodexAppServerDaemonProxyClient(params: Readonly<{
  cwd: string;
  processEnv: NodeJS.ProcessEnv;
}>) {
  return await createCodexAppServerClient({
    cwd: params.cwd,
    processEnv: params.processEnv,
    transport: { kind: 'daemonProxy' },
  });
}

function loadedThreadIds(value: unknown): readonly string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const id = (entry as { id?: unknown }).id;
    return typeof id === 'string' ? [id] : [];
  });
}

export async function isCodexThreadLoadedInAppServerDaemon(params: Readonly<{
  cwd: string;
  processEnv: NodeJS.ProcessEnv;
  threadId: string;
}>): Promise<boolean> {
  let client: Awaited<ReturnType<typeof createCodexAppServerDaemonProxyClient>> | null = null;
  try {
    client = await createCodexAppServerDaemonProxyClient(params);
    const result = await client.request('thread/loaded/list');
    return loadedThreadIds(result).includes(params.threadId);
  } catch {
    return false;
  } finally {
    await client?.dispose().catch(() => undefined);
  }
}
