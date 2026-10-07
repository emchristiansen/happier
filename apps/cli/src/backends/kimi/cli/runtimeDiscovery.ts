import { resolveProviderCliCommandCandidates, type ProviderCliResolutionSource } from '@happier-dev/cli-common/providers';

import { kimiTransport } from '@/backends/kimi/acp/transport';
import { probeAcpAgentCapabilities, type AcpProbeResult } from '@/capabilities/probes/acpProbe';
import { resolveAcpProbeTimeoutMs } from '@/capabilities/utils/acpProbeTimeout';

export type KimiRuntimeKind = 'current' | 'legacy' | 'unknown';

export type KimiRuntimeCandidate = Readonly<{
  source: ProviderCliResolutionSource;
  command: string;
  kind: KimiRuntimeKind;
  probe?: AcpProbeResult;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasObjectField(value: Record<string, unknown>, key: string): boolean {
  return asRecord(value[key]) !== null;
}

/** Classifies the initialize result by the upstream ACP fingerprints, never by version. */
export function classifyKimiInitialize(value: unknown): KimiRuntimeKind {
  const initialize = asRecord(value);
  const capabilities = asRecord(initialize?.agentCapabilities);
  const sessions = asRecord(capabilities?.sessionCapabilities);
  const mcp = asRecord(capabilities?.mcpCapabilities);
  if (!capabilities || !sessions || !mcp) return 'unknown';

  const hasCommonLegacyShape = capabilities.loadSession === true
    && hasObjectField(sessions, 'list')
    && hasObjectField(sessions, 'resume')
    && mcp.http === true;
  const hasCurrentFingerprint = hasCommonLegacyShape
    && hasObjectField(sessions, 'close')
    && hasObjectField(sessions, 'delete')
    && hasObjectField(sessions, 'fork')
    && mcp.sse === true;
  if (hasCurrentFingerprint) return 'current';

  const hasLegacyFingerprint = hasCommonLegacyShape
    && !hasObjectField(sessions, 'close')
    && !hasObjectField(sessions, 'delete')
    && !hasObjectField(sessions, 'fork')
    && mcp.sse === false;
  return hasLegacyFingerprint ? 'legacy' : 'unknown';
}

export function classifyKimiProbe(probe: AcpProbeResult): KimiRuntimeKind {
  return probe.ok
    ? classifyKimiInitialize({ agentCapabilities: probe.agentCapabilities })
    : 'unknown';
}

export function selectKimiRuntimeCandidate(
  candidates: readonly KimiRuntimeCandidate[],
): KimiRuntimeCandidate | null {
  return candidates.find((candidate) => candidate.kind === 'current')
    ?? candidates.find((candidate) => candidate.kind === 'legacy')
    ?? candidates[0]
    ?? null;
}

export async function discoverKimiRuntimeCandidates(params: Readonly<{
  processEnv?: NodeJS.ProcessEnv;
  cwd?: string;
  probeTimeoutMs?: number;
}> = {}): Promise<KimiRuntimeCandidate[]> {
  const processEnv = params.processEnv ?? process.env;
  const candidates = resolveProviderCliCommandCandidates('kimi', { processEnv });
  return await Promise.all(candidates.map(async (candidate): Promise<KimiRuntimeCandidate> => {
    const probe = await probeAcpAgentCapabilities({
      command: candidate.command,
      args: ['acp'],
      cwd: params.cwd ?? process.cwd(),
      env: { ...processEnv, NODE_ENV: 'production', DEBUG: '' },
      transport: kimiTransport,
      timeoutMs: params.probeTimeoutMs ?? resolveAcpProbeTimeoutMs('kimi', kimiTransport.getInitTimeout()),
    });
    return { ...candidate, kind: classifyKimiProbe(probe), probe };
  }));
}

export async function requireCurrentKimiRuntime(params: Readonly<{
  processEnv?: NodeJS.ProcessEnv;
  cwd?: string;
  probeTimeoutMs?: number;
}> = {}): Promise<KimiRuntimeCandidate> {
  const candidates = await discoverKimiRuntimeCandidates(params);
  const selected = selectKimiRuntimeCandidate(candidates);
  if (selected?.kind === 'current') return selected;
  if (selected?.kind === 'legacy') {
    throw new Error(
      `Legacy kimi-cli detected at ${selected.command}. Install the current Kimi Code CLI, then run \`kimi migrate\` manually. Happier never runs migration automatically.`,
    );
  }
  if (selected) {
    throw new Error(
      `Could not identify the Kimi runtime at ${selected.command} through a no-auth ACP initialize probe. Install the current Kimi Code CLI and retry.`,
    );
  }
  throw new Error('Kimi Code CLI was not found. Install it from https://moonshotai.github.io/kimi-code/ and retry.');
}
