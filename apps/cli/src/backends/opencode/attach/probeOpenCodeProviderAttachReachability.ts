import type { ProviderAttachReachability } from '@/backends/types';

import { resolveOpenCodeAttachTargetAuthHeaders } from '@/backends/opencode/localControl/openCodeAttachTargetAuth';
import { resolveOpenCodeAttachCliDialect } from '@/backends/opencode/localControl/resolveOpenCodeAttachCliDialect';

import { resolveOpenCodeProviderAttachTarget } from './evaluateOpenCodeProviderAttachEligibility';

function isValidHttpBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function probeOpenCodeProviderAttachReachability(params: Readonly<{
  metadata: Record<string, unknown>;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}>): Promise<ProviderAttachReachability> {
  const target = resolveOpenCodeProviderAttachTarget(params.metadata);
  if (!target.eligible) {
    return {
      reachable: false,
      reason: target.reason,
    };
  }

  if (!isValidHttpBaseUrl(target.baseUrl)) {
    return {
      reachable: false,
      reason: 'Session includes an invalid OpenCode server URL.',
    };
  }

  try {
    // A Happier-managed (loopback) server answers 401 without its retained credential, so an
    // unauthenticated probe would report every managed session as unreachable. Remote targets keep
    // only the ambient operator credential.
    const headers = await resolveOpenCodeAttachTargetAuthHeaders({ baseUrl: target.baseUrl });
    // Reuse the attach dialect probe as the reachability contract. It recognizes both released V2
    // (`/api/info`) and retained V1 (`/global/health`) and refuses to infer V1 from a failed probe.
    await resolveOpenCodeAttachCliDialect({
      baseUrl: target.baseUrl,
      headers,
      timeoutMs: params.timeoutMs ?? 1_500,
      ...(params.fetchFn ? { fetchFn: params.fetchFn } : {}),
    });
    return { reachable: true };
  } catch {
    return {
      reachable: false,
      reason: 'Remote OpenCode server is unreachable.',
    };
  }
}
