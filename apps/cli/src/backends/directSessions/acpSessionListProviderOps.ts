import { isAcpSessionListingDeclared, type AgentId } from '@happier-dev/agents';
import type { DirectSessionCandidateV1 } from '@happier-dev/protocol';

import {
  AcpSessionCapabilityNotNegotiatedError,
  type AcpListedSession,
  type AcpSessionListPage,
} from '@/agent/acp/AcpBackend';
import { createCatalogAcpBackend } from '@/agent/acp/createCatalogAcpBackend';
import type { AgentBackend } from '@/agent/core';
import type { CatalogAgentId } from '@/backends/types';

import {
  DirectSessionsProviderUnavailableError,
  type DirectSessionCandidatesPage,
  type DirectSessionProviderOps,
} from './providerOps';

type AcpSessionListingBackend = AgentBackend & {
  listSessions?: (params: Readonly<{ cwd?: string | null; cursor?: string | null }>) => Promise<AcpSessionListPage>;
  deleteSession?: (params: Readonly<{ sessionId: string }>) => Promise<void>;
};

async function createSharedAcpBackend(params: Readonly<{ agentId: AgentId; cwd: string }>): Promise<AgentBackend> {
  const created = await createCatalogAcpBackend(params.agentId as CatalogAgentId, {
    cwd: params.cwd,
    mcpServers: {},
    // Listing never prompts; a session is never opened on this connection.
    permissionHandler: { handleToolCall: async () => ({ decision: 'denied' as const }) },
  });
  return created.backend;
}

function matchesSearchTerm(session: AcpListedSession, searchTerm: string): boolean {
  const needle = searchTerm.toLowerCase();
  return (session.title ?? '').toLowerCase().includes(needle)
    || session.sessionId.toLowerCase().includes(needle)
    || (session.cwd ?? '').toLowerCase().includes(needle);
}

function toCandidate(session: AcpListedSession): DirectSessionCandidateV1 {
  return {
    // Byte-exact provider identifier: it is only meaningful to the agent that produced it.
    remoteSessionId: session.sessionId,
    ...(session.title ? { title: session.title } : {}),
    updatedAtMs: session.updatedAtMs ?? 0,
    // Resume-only: Happier cannot observe whether the agent-owned session is running, so activity
    // stays `unknown` rather than implying a live, followable or takeable session.
    activity: 'unknown',
    ...(session.cwd ? { details: { path: session.cwd } } : {}),
  };
}

/**
 * Generic direct-sessions ops backed by ACP `session/list`.
 *
 * Every candidate is resume-only: it maps to a vendor resume id for a new Happier-owned ACP session
 * and carries no takeover, follow, writer-safety, terminal-attachment or transcript guarantee. The
 * corresponding ops are therefore intentionally absent instead of faked, so the daemon reports
 * `provider_unavailable` for them.
 */
export function createAcpSessionListDirectSessionProviderOps(agentId: AgentId): DirectSessionProviderOps {
  return {
    listCandidates: async ({ source, cursor, searchTerm }): Promise<DirectSessionCandidatesPage> => {
      if (source.kind !== 'acpSessionList') {
        throw new DirectSessionsProviderUnavailableError(
          `Agent '${agentId}' only enumerates sessions through the ACP session/list source.`,
        );
      }
      if (!isAcpSessionListingDeclared(agentId)) {
        throw new DirectSessionsProviderUnavailableError(
          `Agent '${agentId}' does not declare ACP session listing.`,
        );
      }

      const cwd = typeof source.cwd === 'string' && source.cwd.trim().length > 0 ? source.cwd : null;
      // `cwd` is the ACP listing filter, not a location Happier must be able to run in: the
      // daemon may be asked about a directory that no longer exists. The short-lived listing
      // process therefore always launches from the daemon's own working directory.
      const backend = (await createSharedAcpBackend({ agentId, cwd: process.cwd() })) as AcpSessionListingBackend;
      let page: AcpSessionListPage;
      try {
        if (typeof backend.listSessions !== 'function') {
          throw new DirectSessionsProviderUnavailableError(
            `Agent '${agentId}' backend does not implement ACP session listing.`,
          );
        }
        page = await backend.listSessions({ cwd, cursor: cursor ?? null });
      } catch (error) {
        if (error instanceof AcpSessionCapabilityNotNegotiatedError) {
          throw new DirectSessionsProviderUnavailableError(error.message);
        }
        throw error;
      } finally {
        // The listing connection is short-lived on both the success and the failure path.
        await backend.dispose().catch(() => undefined);
      }

      const normalizedSearchTerm = typeof searchTerm === 'string' ? searchTerm.trim() : '';
      const matched = normalizedSearchTerm
        ? page.sessions.filter((session) => matchesSearchTerm(session, normalizedSearchTerm))
        : page.sessions;

      return {
        candidates: matched.map(toCandidate),
        nextCursor: page.nextCursor,
        capabilities: { deleteCandidate: page.canDelete },
        // ACP owns pagination, so a search only saw the page the agent returned.
        ...(normalizedSearchTerm ? { searchIncomplete: true } : {}),
      };
    },
    deleteCandidate: async ({ source, remoteSessionId }): Promise<void> => {
      if (source.kind !== 'acpSessionList') {
        throw new DirectSessionsProviderUnavailableError(
          `Agent '${agentId}' only deletes sessions through the ACP session/list source.`,
        );
      }
      if (!isAcpSessionListingDeclared(agentId)) {
        throw new DirectSessionsProviderUnavailableError(
          `Agent '${agentId}' does not declare ACP session listing.`,
        );
      }

      const backend = (await createSharedAcpBackend({ agentId, cwd: process.cwd() })) as AcpSessionListingBackend;
      try {
        if (typeof backend.deleteSession !== 'function') {
          throw new DirectSessionsProviderUnavailableError(
            `Agent '${agentId}' backend does not implement ACP session deletion.`,
          );
        }
        await backend.deleteSession({ sessionId: remoteSessionId });
      } catch (error) {
        if (error instanceof AcpSessionCapabilityNotNegotiatedError) {
          throw new DirectSessionsProviderUnavailableError(error.message);
        }
        throw error;
      } finally {
        await backend.dispose().catch(() => undefined);
      }
    },
  };
}
