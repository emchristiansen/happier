import { createHash } from 'node:crypto';

import type { McpServerConfig } from '@/agent';
import type { PermissionMode } from '@/api/types';
import {
  buildOpenCodeSessionPermissionRuleset,
  OPENCODE_HAPPIER_MCP_ALWAYS_ALLOWED_TOOL_SUFFIXES,
  resolveOpenCodeFamilyPermissionConfig,
  type OpenCodePermissionValue,
} from '@/backends/openCodeFamily/permission/openCodeFamilyPermissionPolicy';

const OPEN_CODE_HAPPIER_SESSION_MCP_PREFIX = 'happier-session-';
const OPEN_CODE_MCP_NAMESPACE_MAX_LENGTH = 64;
const OPEN_CODE_MCP_NAMESPACE_DIGEST_LENGTH = 16;

function sanitizeOpenCodeMcpClientName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function projectOpenCodeMcpClientName(sessionId: string, originalName: string): string {
  const candidate = sanitizeOpenCodeMcpClientName(
    `${OPEN_CODE_HAPPIER_SESSION_MCP_PREFIX}${sessionId}--${originalName}`,
  );
  if (candidate.length <= OPEN_CODE_MCP_NAMESPACE_MAX_LENGTH) return candidate;

  const digest = createHash('sha256')
    .update(sessionId)
    .update('\0')
    .update(originalName)
    .digest('hex')
    .slice(0, OPEN_CODE_MCP_NAMESPACE_DIGEST_LENGTH);
  const prefixLength = OPEN_CODE_MCP_NAMESPACE_MAX_LENGTH - digest.length - 1;
  return `${candidate.slice(0, prefixLength)}-${digest}`;
}

export type OpenCodeSessionMcpRegistration = Readonly<{
  originalName: string;
  projectedName: string;
  config: McpServerConfig;
}>;

export type OpenCodeSessionMcpProjection = Readonly<{
  registrations: readonly OpenCodeSessionMcpRegistration[];
  requiredHappierServerName: string | null;
}>;

export function projectOpenCodeSessionMcpServers(
  happierSessionId: string,
  mcpServers: Readonly<Record<string, McpServerConfig>>,
): OpenCodeSessionMcpProjection {
  const sessionId = sanitizeOpenCodeMcpClientName(happierSessionId.trim());
  if (!sessionId) throw new Error('OpenCode MCP projection requires a Happier session id');
  const registrations = Object.entries(mcpServers).flatMap(([rawName, config]) => {
    const originalName = rawName.trim();
    if (!originalName) return [];
    return [{
      originalName,
      projectedName: projectOpenCodeMcpClientName(sessionId, originalName),
      config,
    } satisfies OpenCodeSessionMcpRegistration];
  });
  return Object.freeze({
    registrations: Object.freeze(registrations),
    requiredHappierServerName:
      registrations.find(({ originalName }) => originalName === 'happier')?.projectedName ?? null,
  });
}

export function buildOpenCodeSessionScopedPermissionRuleset(
  permissionMode: PermissionMode | null | undefined,
  projection: OpenCodeSessionMcpProjection,
): ReadonlyArray<{ permission: string; pattern: string; action: OpenCodePermissionValue }> {
  const baseRules = buildOpenCodeSessionPermissionRuleset(permissionMode);
  const ownNamespaceAction = resolveOpenCodeFamilyPermissionConfig(permissionMode)['*'];
  const ownNamespaceRules = projection.registrations.map(({ projectedName }) => ({
    permission: `${sanitizeOpenCodeMcpClientName(projectedName)}_*`,
    pattern: '*',
    action: ownNamespaceAction,
  }));
  const requiredHappierAlias = projection.requiredHappierServerName
    ? sanitizeOpenCodeMcpClientName(projection.requiredHappierServerName)
    : null;
  const safeHappierRules = requiredHappierAlias
    ? OPENCODE_HAPPIER_MCP_ALWAYS_ALLOWED_TOOL_SUFFIXES.map((suffix) => ({
        permission: `${requiredHappierAlias}_${suffix}`,
        pattern: '*',
        action: 'allow' as const,
      }))
    : [];
  return Object.freeze([
    ...baseRules,
    { permission: `${OPEN_CODE_HAPPIER_SESSION_MCP_PREFIX}*`, pattern: '*', action: 'deny' as const },
    ...ownNamespaceRules,
    ...safeHappierRules,
  ]);
}

export function resolveOpenCodeChangeTitleToolNameForMcpClient(mcpClientName: string): string {
  return `${sanitizeOpenCodeMcpClientName(mcpClientName)}_change_title`;
}

export function resolveOpenCodeSessionTitleSetToolNameForMcpClient(mcpClientName: string): string {
  return `${sanitizeOpenCodeMcpClientName(mcpClientName)}_session_title_set`;
}

export function canonicalizeOpenCodeConfiguredMcpToolName(
  rawToolName: string,
  projection: OpenCodeSessionMcpProjection,
): string | null {
  const trimmed = rawToolName.trim();
  if (!trimmed || trimmed.startsWith('mcp__')) return null;

  const matchingRegistration = projection.registrations
    .map((registration) => ({
      registration,
      projectedAlias: sanitizeOpenCodeMcpClientName(registration.projectedName),
    }))
    .filter(({ projectedAlias }) => trimmed.startsWith(`${projectedAlias}_`))
    .sort((left, right) => right.projectedAlias.length - left.projectedAlias.length)[0];
  if (!matchingRegistration) return null;

  const toolSuffix = trimmed.slice(matchingRegistration.projectedAlias.length + 1).trim();
  if (!toolSuffix) return null;

  return `mcp__${sanitizeOpenCodeMcpClientName(matchingRegistration.registration.originalName)}__${toolSuffix}`;
}
