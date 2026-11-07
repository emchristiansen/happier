import type { SessionConfigOption } from '@/agent/acp/AcpBackend';

import { modelConfigOptionControlId, modelParamControlId } from './cursorModelConfigControls';
import type { SessionConfigOptionValue } from './cursorModelConfigTypes';
import {
  normalizeCursorModelVariantBaseId,
  normalizeToken,
  stringifyConfigValue,
  stripParameterizedSuffix,
} from './cursorModelConfigParsing';

export function isCursorModelConfigOption(option: SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  const category = option.category?.trim().toLowerCase();
  return category === 'model' || id === 'model' || name === 'model';
}

export function findCursorModelConfigOption(
  configOptions: ReadonlyArray<SessionConfigOption>,
): SessionConfigOption | undefined {
  return configOptions.find((option) => isCursorModelConfigOption(option) && Array.isArray(option.options));
}

export function isCursorModeConfigOption(option: SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  const category = option.category?.trim().toLowerCase();
  return category === 'mode' || id === 'mode' || name === 'mode';
}

export function findCursorModeConfigOption(
  configOptions: ReadonlyArray<SessionConfigOption>,
): SessionConfigOption | undefined {
  return configOptions.find((option) => isCursorModeConfigOption(option) && (option.options?.length ?? 0) > 0);
}

function matchesConfigOption(
  option: SessionConfigOption,
  ids: ReadonlySet<string>,
  nameFragments: ReadonlyArray<string>,
): boolean {
  const id = normalizeToken(option.id);
  const name = normalizeToken(option.name);
  return ids.has(id) || nameFragments.some((fragment) => name.includes(fragment));
}

export function findConfigOption(
  configOptions: ReadonlyArray<SessionConfigOption>,
  ids: ReadonlyArray<string>,
  nameFragments: ReadonlyArray<string>,
): SessionConfigOption | undefined {
  const idSet = new Set(ids.map(normalizeToken));
  return configOptions.find((option) => matchesConfigOption(option, idSet, nameFragments));
}

export function findSelectOptionValue(option: SessionConfigOption | undefined, requested: string): string | undefined {
  const requestedToken = normalizeCursorSelectOptionToken(requested);
  const choice = option?.options?.find((candidate) =>
    normalizeCursorSelectOptionToken(candidate.value) === requestedToken ||
    normalizeCursorSelectOptionToken(candidate.name) === requestedToken
  );
  return choice ? stringifyConfigValue(choice.value) : undefined;
}

function normalizeCursorSelectOptionToken(value: SessionConfigOptionValue | undefined): string {
  const token = normalizeToken(value);
  return token === 'xhigh' ? 'extra-high' : token;
}

export function findBooleanConfigValue(
  option: SessionConfigOption | undefined,
  requested: boolean,
): string | boolean | undefined {
  if (!option) return undefined;
  if (option.type === 'boolean') return requested;
  return findSelectOptionValue(option, String(requested));
}

export function findDefaultModelChoice(
  choices: NonNullable<SessionConfigOption['options']>,
): NonNullable<SessionConfigOption['options']>[number] | undefined {
  return choices.find((choice) => normalizeToken(choice.value) === 'default') ??
    choices.find((choice) => stringifyConfigValue(choice.value).trim().toLowerCase() === 'default[]') ??
    choices.find((choice) => {
      const name = normalizeToken(choice.name);
      return name === 'default' || name === 'auto';
    });
}

export function modelChoiceBaseMatches(
  choiceValueRaw: SessionConfigOptionValue,
  requestedBases: ReadonlySet<string>,
): boolean {
  const choiceValue = stringifyConfigValue(choiceValueRaw);
  const base = stripParameterizedSuffix(choiceValue);
  return requestedBases.has(base) || requestedBases.has(normalizeCursorModelVariantBaseId(base));
}

export function findRealConfigOption(
  configOptions: ReadonlyArray<SessionConfigOption>,
  configId: string,
): SessionConfigOption | undefined {
  return configOptions.find((option) => option.id === configId && !isCursorModelConfigOption(option));
}

export function findRealConfigOptionByControlId(
  configOptions: ReadonlyArray<SessionConfigOption>,
  configId: string,
): SessionConfigOption | undefined {
  const controlId = modelParamControlId(configId);
  if (!controlId) return undefined;
  return configOptions.find((option) =>
    !isCursorModelConfigOption(option) &&
    !isCursorModeConfigOption(option) &&
    modelConfigOptionControlId(option) === controlId
  );
}

export function normalizeDirectConfigOptionUpdateValue(
  option: SessionConfigOption,
  value: string | number | boolean | null,
): string | number | boolean | null {
  if (option.type === 'boolean' && typeof value === 'string') {
    const normalized = normalizeToken(value);
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return value;
}

export function normalizeSessionConfigUpdateValue(
  value: string | number | boolean | null,
): string | number | boolean | null | undefined {
  if (typeof value === 'string') {
    return value.trim().length > 0 ? value : undefined;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean' || value === null) return value;
  return undefined;
}
