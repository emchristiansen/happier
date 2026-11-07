import { providers } from '@happier-dev/agents';

import type { OpenCodeModelRef } from './types';
import { asRecord, normalizeString } from './openCodeParsing';

type KnownUnavailableOpenCodeModel = Readonly<{
  retiredAtMs: number;
  replacementModelId: string;
}>;

// Retired Anthropic Opus-lineage models are substituted with the current flagship Claude model
// (single source of truth), so a new Opus release never leaves this table pointing at a stale id.
const FLAGSHIP_CLAUDE_MODEL_ID = providers.claude.CURRENT_FLAGSHIP_CLAUDE_MODEL_ID;

const ANTHROPIC_KNOWN_UNAVAILABLE_MODELS: Readonly<Record<string, KnownUnavailableOpenCodeModel>> = Object.freeze({
  'claude-2.0': { retiredAtMs: Date.UTC(2025, 6, 21), replacementModelId: FLAGSHIP_CLAUDE_MODEL_ID },
  'claude-2.1': { retiredAtMs: Date.UTC(2025, 6, 21), replacementModelId: FLAGSHIP_CLAUDE_MODEL_ID },
  'claude-instant-1.0': { retiredAtMs: Date.UTC(2024, 10, 6), replacementModelId: 'claude-haiku-4-5-20251001' },
  'claude-instant-1.1': { retiredAtMs: Date.UTC(2024, 10, 6), replacementModelId: 'claude-haiku-4-5-20251001' },
  'claude-instant-1.2': { retiredAtMs: Date.UTC(2024, 10, 6), replacementModelId: 'claude-haiku-4-5-20251001' },
  'claude-3-opus-20240229': { retiredAtMs: Date.UTC(2026, 0, 5), replacementModelId: FLAGSHIP_CLAUDE_MODEL_ID },
  'claude-3-opus-latest': { retiredAtMs: Date.UTC(2026, 0, 5), replacementModelId: FLAGSHIP_CLAUDE_MODEL_ID },
  'claude-3-sonnet-20240229': { retiredAtMs: Date.UTC(2025, 6, 21), replacementModelId: 'claude-sonnet-4-6' },
  'claude-3-sonnet-latest': { retiredAtMs: Date.UTC(2025, 6, 21), replacementModelId: 'claude-sonnet-4-6' },
  'claude-3-haiku-20240307': { retiredAtMs: Date.UTC(2026, 3, 20), replacementModelId: 'claude-haiku-4-5-20251001' },
  'claude-3-haiku-latest': { retiredAtMs: Date.UTC(2026, 3, 20), replacementModelId: 'claude-haiku-4-5-20251001' },
  'claude-3-5-sonnet-20240620': { retiredAtMs: Date.UTC(2025, 9, 28), replacementModelId: 'claude-sonnet-4-6' },
  'claude-3-5-sonnet-20241022': { retiredAtMs: Date.UTC(2025, 9, 28), replacementModelId: 'claude-sonnet-4-6' },
  'claude-3-5-sonnet-latest': { retiredAtMs: Date.UTC(2025, 9, 28), replacementModelId: 'claude-sonnet-4-6' },
  'claude-3-5-haiku-20241022': { retiredAtMs: Date.UTC(2026, 1, 19), replacementModelId: 'claude-haiku-4-5-20251001' },
  'claude-3-5-haiku-latest': { retiredAtMs: Date.UTC(2026, 1, 19), replacementModelId: 'claude-haiku-4-5-20251001' },
  'claude-3-7-sonnet-20250219': { retiredAtMs: Date.UTC(2026, 1, 19), replacementModelId: 'claude-sonnet-4-6' },
  'claude-3-7-sonnet-latest': { retiredAtMs: Date.UTC(2026, 1, 19), replacementModelId: 'claude-sonnet-4-6' },
  'claude-sonnet-4-20250514': { retiredAtMs: Date.UTC(2026, 5, 15), replacementModelId: 'claude-sonnet-4-6' },
  'claude-opus-4-20250514': { retiredAtMs: Date.UTC(2026, 5, 15), replacementModelId: FLAGSHIP_CLAUDE_MODEL_ID },
});

const KNOWN_UNAVAILABLE_MODELS_BY_PROVIDER: Readonly<Record<string, Readonly<Record<string, KnownUnavailableOpenCodeModel>>>> = Object.freeze({
  anthropic: ANTHROPIC_KNOWN_UNAVAILABLE_MODELS,
});

export function parseOpenCodeModelId(raw: string): OpenCodeModelRef | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const idx = trimmed.indexOf('/');
  if (idx <= 0 || idx === trimmed.length - 1) return null;
  return { providerID: trimmed.slice(0, idx), modelID: trimmed.slice(idx + 1) };
}

export function resolveOpenCodeDefaultProviderIdFromModelId(modelId: string): string {
  const trimmed = modelId.trim();
  const idx = trimmed.indexOf('/');
  if (idx <= 0) return '';
  return trimmed.slice(0, idx);
}

export function getKnownUnavailableOpenCodeModel(params: Readonly<{
  providerID: string;
  modelID: string;
  nowMs?: number;
}>): KnownUnavailableOpenCodeModel | null {
  const providerID = normalizeString(params.providerID).toLowerCase();
  const modelID = normalizeString(params.modelID).toLowerCase();
  if (!providerID || !modelID) return null;
  const providerModels = KNOWN_UNAVAILABLE_MODELS_BY_PROVIDER[providerID];
  const entry = providerModels?.[modelID] ?? null;
  if (!entry) return null;
  const nowMs = typeof params.nowMs === 'number' && Number.isFinite(params.nowMs)
    ? params.nowMs
    : Date.now();
  return nowMs >= entry.retiredAtMs ? entry : null;
}

export function isKnownUnavailableOpenCodeModel(params: Readonly<{
  providerID: string;
  modelID: string;
  nowMs?: number;
}>): boolean {
  return getKnownUnavailableOpenCodeModel(params) !== null;
}

/**
 * Shared eligibility for discovery, selection, and compaction. OpenCode supports text models
 * without tool calling, so tool support must not change membership between those consumers.
 * Missing inventory preserves custom-model selection; known retired models remain excluded.
 */
export function isOpenCodeModelSelectable(model: Readonly<{
  providerID: string;
  modelID: string;
  modelRecord?: unknown;
}>): boolean {
  const providerID = normalizeString(model.providerID);
  const modelID = normalizeString(model.modelID);
  if (!providerID || !modelID) return false;
  if (isKnownUnavailableOpenCodeModel({ providerID, modelID })) return false;
  return modelIsActive(model.modelRecord) && modelSupportsTextInput(model.modelRecord);
}

export function modelIsActive(raw: unknown): boolean {
  const rec = asRecord(raw);
  if (!rec) return true;
  const status = normalizeString(rec.status);
  return !status || status === 'active';
}

export function modelSupportsTextInput(raw: unknown): boolean {
  const rec = asRecord(raw);
  if (!rec) return true;
  const capabilities = asRecord(rec.capabilities);
  if (!capabilities) return true;
  const input = capabilities.input;
  if (Array.isArray(input)) return input.some((value) => normalizeString(value) === 'text');
  const inputRecord = asRecord(input);
  return !inputRecord || inputRecord.text !== false;
}

/** V2 has no `capabilities.reasoning`; a non-empty `variants` list is the released equivalent. */
export function modelSupportsReasoningVariants(raw: unknown): boolean {
  const rec = asRecord(raw);
  if (!rec) return false;
  const capabilities = asRecord(rec.capabilities);
  if (capabilities?.reasoning === true) return true;
  return Array.isArray(rec.variants) && rec.variants.length > 0;
}
