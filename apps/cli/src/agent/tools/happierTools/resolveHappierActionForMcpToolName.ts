import {
  getActionSpec,
  listActionSpecs,
  type ActionId,
} from '@happier-dev/protocol';

import { getEquivalentActionIdForBuiltInTool } from './actionToolCatalog';

const ACTION_IDS = new Set<ActionId>(listActionSpecs().map((spec) => spec.id as ActionId));

function normalizeToolName(raw: unknown): string {
  return String(raw ?? '').trim();
}

function normalizeFirstPartyHappierToolName(toolName: string): string | null {
  const normalized = normalizeToolName(toolName);
  if (!normalized) return null;
  if (normalized.startsWith('mcp__happier__')) return normalized.slice('mcp__happier__'.length);
  if (normalized.startsWith('happier__')) return normalized.slice('happier__'.length);
  if (normalized.startsWith('happier_')) return normalized.slice('happier_'.length);
  if (getEquivalentActionIdForBuiltInTool(normalized)) return normalized;
  return null;
}

function readActionExecuteActionId(input: unknown): ActionId | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = normalizeToolName((input as Record<string, unknown>).actionId);
  if (!ACTION_IDS.has(raw as ActionId)) return null;
  return raw as ActionId;
}

export function resolveHappierActionForMcpToolName(params: Readonly<{
  toolName: string;
  input: unknown;
}>): ActionId | null {
  const firstPartyToolName = normalizeFirstPartyHappierToolName(params.toolName);
  if (!firstPartyToolName) return null;
  if (firstPartyToolName === 'action_execute') return readActionExecuteActionId(params.input);
  return getEquivalentActionIdForBuiltInTool(firstPartyToolName);
}

/**
 * Whether this provider-facing tool call is only the transport wrapper for a
 * known safe first-party Action. Admitting that wrapper does not admit the
 * Action: the canonical Action executor still owns enablement and configured
 * approval. Danger-classified and opaque Action calls stay with provider
 * permission handling.
 */
export function isSafeFirstPartyHappierActionToolCall(params: Readonly<{
  toolName: string;
  input: unknown;
}>): boolean {
  const actionId = resolveHappierActionForMcpToolName(params);
  return actionId !== null && getActionSpec(actionId).safety === 'safe';
}
