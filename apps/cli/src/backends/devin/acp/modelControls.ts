import type {
  AcpSessionModelAdapter,
  SessionConfigOption,
  SessionModel,
  SessionModelState,
} from '@/agent/acp/AcpBackend';
import { readNonBlankSessionControlIdentifier } from '@/agent/runtime/sessionControlIdentifiers';

const REASONING_EFFORT_OPTION_ID = 'reasoning_effort';
const SPEED_OPTION_ID = 'service_tier';
const STANDARD_SPEED = 'standard';
const EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

type DevinSpeedSuffix = '' | 'fast' | 'priority';

type DevinModelVariant = Readonly<{
  model: SessionModel;
  stemId: string;
  effort: string;
  speedSuffix: DevinSpeedSuffix;
  legacyProjectedId: string;
  legacyProjectedName: string;
  baseProjectedName: string;
}>;

function parseModelId(modelId: string): Readonly<{
  stemId: string;
  effort: string;
  speedSuffix: DevinSpeedSuffix;
}> | null {
  const match = /^(.*)-(none|low|medium|high|xhigh|max)(?:-(fast|priority))?$/.exec(modelId);
  if (!match) return null;
  const [, stemId, effort, rawSpeedSuffix = ''] = match;
  if (!stemId || !effort || !EFFORTS.has(effort)) return null;
  return { stemId, effort, speedSuffix: rawSpeedSuffix as DevinSpeedSuffix };
}

function formatEffort(effort: string): string {
  if (effort === 'none') return 'None';
  if (effort === 'xhigh') return 'XHigh';
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

function parseVariant(model: SessionModel): DevinModelVariant | null {
  const parsed = parseModelId(model.id);
  if (!parsed) return null;
  const legacyProjectedName = model.name.replace(
    /\s+(?:No|Low|Medium|High|X-?High|Max)(?: Thinking)?(?=\s+Fast$|$)/i,
    '',
  );
  if (legacyProjectedName === model.name || !legacyProjectedName.trim()) return null;
  const baseProjectedName = parsed.speedSuffix
    ? legacyProjectedName.replace(/\s+Fast$/i, '')
    : legacyProjectedName;
  if (!baseProjectedName.trim()) return null;
  return {
    model,
    stemId: parsed.stemId,
    effort: parsed.effort,
    speedSuffix: parsed.speedSuffix,
    legacyProjectedId: `${parsed.stemId}${parsed.speedSuffix ? `-${parsed.speedSuffix}` : ''}`,
    legacyProjectedName,
    baseProjectedName,
  };
}

function isCompleteSpeedMatrix(variants: readonly DevinModelVariant[]): boolean {
  const efforts = new Set(variants.map((variant) => variant.effort));
  const speeds = new Set(variants.map((variant) => variant.speedSuffix));
  if (efforts.size < 2 || !speeds.has('') || speeds.size < 2) return false;
  if (new Set(variants.map((variant) => variant.baseProjectedName)).size !== 1) return false;
  // A family using both provider suffix spellings would expose two indistinguishable Fast choices.
  if ([...speeds].filter(Boolean).length !== 1) return false;
  const tuples = new Set(variants.map((variant) => `${variant.effort}\u0000${variant.speedSuffix}`));
  return tuples.size === variants.length && variants.length === efforts.size * speeds.size;
}

type ProjectedVariant = Readonly<{
  variant: DevinModelVariant;
  projectedId: string;
  projectedName: string;
  exposesSpeed: boolean;
}>;

function buildProjectedVariants(
  normalizedModelState: Readonly<SessionModelState>,
): readonly ProjectedVariant[] {
  const parsed = normalizedModelState.availableModels.flatMap((model) => {
    const variant = parseVariant(model);
    return variant ? [variant] : [];
  });
  const variantsByStem = new Map<string, DevinModelVariant[]>();
  for (const variant of parsed) {
    const variants = variantsByStem.get(variant.stemId) ?? [];
    variants.push(variant);
    variantsByStem.set(variant.stemId, variants);
  }
  const speedStems = new Set(
    [...variantsByStem.entries()]
      .filter(([stemId, variants]) => isCompleteSpeedMatrix(variants)
        && !normalizedModelState.availableModels.some((model) => model.id === stemId))
      .map(([stemId]) => stemId),
  );
  return parsed.map((variant) => speedStems.has(variant.stemId)
    ? {
        variant,
        projectedId: variant.stemId,
        projectedName: variant.baseProjectedName,
        exposesSpeed: true,
      }
    : {
        variant,
        projectedId: variant.legacyProjectedId,
        projectedName: variant.legacyProjectedName,
        exposesSpeed: false,
      });
}

function createReasoningEffortOption(
  variants: readonly ProjectedVariant[],
  selected: ProjectedVariant,
): SessionConfigOption | null {
  const compatible = variants.filter((candidate) => (
    !selected.exposesSpeed || candidate.variant.speedSuffix === selected.variant.speedSuffix
  ));
  const values = [...new Set(compatible.map((candidate) => candidate.variant.effort))];
  if (values.length < 2) return null;
  return {
    id: REASONING_EFFORT_OPTION_ID,
    name: 'Reasoning effort',
    type: 'select',
    currentValue: selected.variant.effort,
    options: values.map((value) => ({ value, name: formatEffort(value) })),
  };
}

function createSpeedOption(
  variants: readonly ProjectedVariant[],
  selected: ProjectedVariant,
): SessionConfigOption | null {
  if (!selected.exposesSpeed) return null;
  const compatible = variants.filter((candidate) => candidate.variant.effort === selected.variant.effort);
  const values = [...new Set(compatible.map(
    (candidate) => candidate.variant.speedSuffix || STANDARD_SPEED,
  ))];
  if (values.length < 2) return null;
  values.sort((left, right) => (
    left === STANDARD_SPEED ? -1 : right === STANDARD_SPEED ? 1 : left.localeCompare(right)
  ));
  return {
    id: SPEED_OPTION_ID,
    name: 'Speed',
    type: 'select',
    currentValue: selected.variant.speedSuffix || STANDARD_SPEED,
    options: values.map((value) => ({
      value,
      name: value === STANDARD_SPEED ? 'Standard' : 'Fast',
    })),
  };
}

function projectModelState(normalizedModelState: Readonly<SessionModelState>): Readonly<SessionModelState> {
  const projectedVariants = buildProjectedVariants(normalizedModelState);
  const variantsByProjectedId = new Map<string, ProjectedVariant[]>();
  for (const projected of projectedVariants) {
    const variants = variantsByProjectedId.get(projected.projectedId) ?? [];
    variants.push(projected);
    variantsByProjectedId.set(projected.projectedId, variants);
  }

  const collapsibleIds = new Set(
    [...variantsByProjectedId.entries()]
      .filter(([, variants]) => variants.length > 1
        && new Set(variants.map((candidate) => candidate.projectedName)).size === 1
        && new Set(variants.map((candidate) => (
          `${candidate.variant.effort}\u0000${candidate.variant.speedSuffix}`
        ))).size === variants.length)
      .filter(([projectedId]) => !normalizedModelState.availableModels.some((model) => model.id === projectedId))
      .map(([projectedId]) => projectedId),
  );
  if (collapsibleIds.size === 0) return normalizedModelState;

  const availableModels: SessionModel[] = [];
  const emittedGroups = new Set<string>();
  for (const model of normalizedModelState.availableModels) {
    const projected = projectedVariants.find((candidate) => candidate.variant.model.id === model.id);
    if (!projected || !collapsibleIds.has(projected.projectedId)) {
      availableModels.push(model);
      continue;
    }
    if (emittedGroups.has(projected.projectedId)) continue;
    emittedGroups.add(projected.projectedId);
    const variants = variantsByProjectedId.get(projected.projectedId)!;
    const selected = variants.find(
      (candidate) => candidate.variant.model.id === normalizedModelState.currentModelId,
    ) ?? variants[0]!;
    const retainedOptions = selected.variant.model.modelOptions?.filter(
      (option) => option.id !== REASONING_EFFORT_OPTION_ID && option.id !== SPEED_OPTION_ID,
    ) ?? [];
    const reasoningOption = createReasoningEffortOption(variants, selected);
    const speedOption = createSpeedOption(variants, selected);
    availableModels.push({
      ...selected.variant.model,
      id: selected.projectedId,
      name: selected.projectedName,
      modelOptions: [
        ...retainedOptions,
        ...(reasoningOption ? [reasoningOption] : []),
        ...(speedOption ? [speedOption] : []),
      ],
    });
  }

  const currentVariant = projectedVariants.find(
    (candidate) => candidate.variant.model.id === normalizedModelState.currentModelId,
  );
  const currentModelId = currentVariant && collapsibleIds.has(currentVariant.projectedId)
    ? currentVariant.projectedId
    : normalizedModelState.currentModelId;
  return { currentModelId, availableModels };
}

function findProjectedModel(modelState: Readonly<SessionModelState> | null, modelId: string): SessionModel | null {
  return modelState?.availableModels.find((model) => model.id === modelId) ?? null;
}

function readSelectedOption(model: SessionModel, optionId: string): string | null {
  const option = model.modelOptions?.find((candidate) => candidate.id === optionId);
  return typeof option?.currentValue === 'string' ? option.currentValue : null;
}

function resolveProjectedModelId(model: SessionModel): string | null {
  const effort = readSelectedOption(model, REASONING_EFFORT_OPTION_ID);
  if (!effort) return null;
  const speed = readSelectedOption(model, SPEED_OPTION_ID);
  if (speed) {
    return `${model.id}-${effort}${speed === STANDARD_SPEED ? '' : `-${speed}`}`;
  }
  for (const suffix of ['priority', 'fast'] as const) {
    if (model.id.endsWith(`-${suffix}`)) {
      return `${model.id.slice(0, -(suffix.length + 1))}-${effort}-${suffix}`;
    }
  }
  return `${model.id}-${effort}`;
}

function resolveProjectedOptionUpdate(params: Readonly<{
  configId: string;
  value: string;
  modelState: Readonly<SessionModelState> | null;
}>): Readonly<{ modelId: string }> | null {
  if (params.configId !== REASONING_EFFORT_OPTION_ID && params.configId !== SPEED_OPTION_ID) return null;
  const currentId = params.modelState?.currentModelId;
  const model = currentId ? findProjectedModel(params.modelState, currentId) : null;
  if (!model) return null;
  const option = model.modelOptions?.find((candidate) => candidate.id === params.configId);
  if (!option?.options?.some((candidate) => candidate.value === params.value)) return null;
  const effort = params.configId === REASONING_EFFORT_OPTION_ID
    ? params.value
    : readSelectedOption(model, REASONING_EFFORT_OPTION_ID);
  if (!effort) return null;
  const speed = params.configId === SPEED_OPTION_ID
    ? params.value
    : readSelectedOption(model, SPEED_OPTION_ID);
  if (speed) {
    return { modelId: `${model.id}-${effort}${speed === STANDARD_SPEED ? '' : `-${speed}`}` };
  }
  for (const suffix of ['priority', 'fast'] as const) {
    if (model.id.endsWith(`-${suffix}`)) {
      return { modelId: `${model.id.slice(0, -(suffix.length + 1))}-${effort}-${suffix}` };
    }
  }
  return { modelId: `${model.id}-${effort}` };
}

function findModelConfigOption(configOptions: ReadonlyArray<SessionConfigOption> | null): SessionConfigOption | null {
  return configOptions?.find((option) => option.id.trim().toLowerCase() === 'model') ?? null;
}

function modelStateFromConfigOptions(
  configOptions: ReadonlyArray<SessionConfigOption> | null,
): SessionModelState | null {
  const modelOption = findModelConfigOption(configOptions);
  if (!modelOption?.options || typeof modelOption.currentValue !== 'string') return null;
  const availableModels = modelOption.options.flatMap((option) => {
    const id = typeof option.value === 'string' ? option.value : '';
    return id && option.name ? [{
      id,
      name: option.name,
      ...(option.description ? { description: option.description } : {}),
    }] : [];
  });
  return availableModels.length > 0 || modelOption.options.length === 0
    ? { currentModelId: modelOption.currentValue, availableModels }
    : null;
}

export function buildDevinSessionModelsFromConfigOptions(
  configOptions: ReadonlyArray<SessionConfigOption> | null,
): SessionModelState | null {
  const state = modelStateFromConfigOptions(configOptions);
  return state ? projectModelState(state) : null;
}

export function resolveDevinSessionModelConfigUpdate(params: Readonly<{
  modelId: string;
  configOptions: ReadonlyArray<SessionConfigOption> | null;
}>): Readonly<{ modelId: string }> | null {
  const requestedModelId = readNonBlankSessionControlIdentifier(params.modelId) ?? '';
  const rawState = modelStateFromConfigOptions(params.configOptions);
  if (!requestedModelId || !rawState) return null;
  if (rawState.availableModels.some((model) => model.id === requestedModelId)) {
    return { modelId: requestedModelId };
  }
  const projected = projectModelState(rawState);
  const model = findProjectedModel(projected, requestedModelId);
  const resolved = model ? resolveProjectedModelId(model) : null;
  return resolved && rawState.availableModels.some((candidate) => candidate.id === resolved)
    ? { modelId: resolved }
    : null;
}

export function resolveDevinSessionConfigOptionUpdate(params: Readonly<{
  configId: string;
  value: string | number | boolean | null;
  configOptions: ReadonlyArray<SessionConfigOption> | null;
}>): Readonly<{ modelId: string }> | Readonly<{
  configId: string;
  value: string | number | boolean | null;
}> | null {
  if (params.configId !== REASONING_EFFORT_OPTION_ID && params.configId !== SPEED_OPTION_ID) {
    return { configId: params.configId, value: params.value };
  }
  if (typeof params.value !== 'string') return null;
  const rawState = modelStateFromConfigOptions(params.configOptions);
  if (!rawState) return null;
  const projected = projectModelState(rawState);
  const resolved = resolveProjectedOptionUpdate({
    configId: params.configId,
    value: params.value,
    modelState: projected,
  });
  return resolved && rawState.availableModels.some((model) => model.id === resolved.modelId)
    ? resolved
    : null;
}

export const devinSessionModelAdapter: AcpSessionModelAdapter = {
  projectModelId: ({ modelId, modelState }) => {
    const parsed = parseModelId(modelId);
    if (!parsed) return modelId;
    const base = findProjectedModel(modelState, parsed.stemId);
    if (base?.modelOptions?.some((option) => option.id === SPEED_OPTION_ID)) return parsed.stemId;
    const legacyId = `${parsed.stemId}${parsed.speedSuffix ? `-${parsed.speedSuffix}` : ''}`;
    const legacy = findProjectedModel(modelState, legacyId);
    return legacy?.modelOptions?.some((option) => option.id === REASONING_EFFORT_OPTION_ID)
      ? legacyId
      : modelId;
  },
  projectModelState: ({ normalizedModelState }) => projectModelState(normalizedModelState),
  deriveModelStateFromConfigOptions: ({ configOptions }) => buildDevinSessionModelsFromConfigOptions(configOptions),
  resolveModelUpdate: ({ modelId, modelState }) => {
    const model = findProjectedModel(modelState, modelId);
    const resolved = model ? resolveProjectedModelId(model) : null;
    return resolved ? { modelId: resolved } : undefined;
  },
  resolveConfigOptionModelUpdate: ({ configId, value, modelState }) => {
    if (configId !== REASONING_EFFORT_OPTION_ID && configId !== SPEED_OPTION_ID) return undefined;
    if (typeof value !== 'string') throw new Error(`Devin ${configId} must be a string`);
    const resolved = resolveProjectedOptionUpdate({ configId, value, modelState });
    if (!resolved) throw new Error(`Devin ${configId} is not advertised for the active model`);
    return resolved;
  },
};
