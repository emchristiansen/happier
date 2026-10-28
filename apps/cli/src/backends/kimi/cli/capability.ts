import { buildAcpCapabilitySnapshot } from '@/capabilities/probes/acpCapabilitySnapshot';
import { buildCliCapabilityData } from '@/capabilities/probes/cliBase';
import type { Capability } from '@/capabilities/service';
import { discoverKimiRuntimeCandidates, selectKimiRuntimeCandidate } from './runtimeDiscovery';

export const cliCapability: Capability = {
  descriptor: { id: 'cli.kimi', kind: 'cli', title: 'Kimi Code CLI' },
  detect: async ({ request, context }) => {
    const candidates = await discoverKimiRuntimeCandidates();
    const selected = selectKimiRuntimeCandidate(candidates);
    const snapshotEntry = context.cliSnapshot?.clis?.kimi;
    // The snapshot may describe the earlier legacy PATH candidate. Its version
    // and authentication state cannot be attributed to a different executable.
    const base = buildCliCapabilityData({
      request,
      entry: selected && snapshotEntry?.resolvedPath === selected.command ? snapshotEntry : undefined,
    });
    return {
      ...base,
      available: selected?.kind === 'current',
      ...(selected ? {
        resolvedPath: selected.command,
        resolvedCommand: selected.command,
        resolutionSource: selected.source,
        kimiRuntime: {
          kind: selected.kind,
          candidates: candidates.map(({ source, command, kind }) => ({ source, command, kind })),
        },
        acp: selected.probe ? buildAcpCapabilitySnapshot(selected.probe) : undefined,
      } : {}),
    };
  },
};
