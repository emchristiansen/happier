import { asRecord, normalizeString } from './openCodeParsing';

/**
 * Released OpenCode V2 (v2.0.15) replaced the question routes/events with forms
 * (`packages/schema/src/form.ts`). Happier's canonical question owner still speaks the
 * `{ questions: [{ question, header, options, multiple }] }` shape and answers with
 * `string[][]` label rows, so the seam is adapted here rather than in the runtime.
 */
export type OpenCodeV2FormFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'multiselect' | 'external';

export type OpenCodeV2FormWhen = Readonly<{ key: string; op: 'eq' | 'neq'; value: string | number | boolean }>;

export type OpenCodeV2FormFieldBinding = Readonly<{
  key: string;
  type: OpenCodeV2FormFieldType;
  /** Maps the label Happier surfaced back to the upstream option value. */
  optionValueByLabel: Readonly<Record<string, string>>;
  /** True when the field is not asked interactively and only its default may be submitted. */
  hidden: boolean;
  /** Present only when the field declares one; used for hidden fields and unanswered prompts. */
  defaultValue?: string | number | boolean | readonly string[];
  /** All conditions must hold for the field to be active and answerable. */
  when: ReadonlyArray<OpenCodeV2FormWhen>;
  /** Declaration index in `Form.Info.fields`; `when.key` must reference an earlier field. */
  order: number;
}>;

export type OpenCodeV2FormProjection = Readonly<{
  /** Shaped for `parseQuestionRequest`. */
  request: Readonly<{ id: string; sessionID: string; questions: ReadonlyArray<Record<string, unknown>> }>;
  /** One binding per asked question, positionally aligned with `request.questions`. */
  bindings: ReadonlyArray<OpenCodeV2FormFieldBinding>;
  /** Fields excluded from the interactive prompt but still submitted from their declared default. */
  hiddenBindings: ReadonlyArray<OpenCodeV2FormFieldBinding>;
  /**
   * Field aspects this projection cannot represent through Happier's AskUserQuestion surface.
   * Recorded rather than silently dropped so a partial projection is visible to callers.
   */
  unrepresentable: ReadonlyArray<Readonly<{ key: string; aspect: string }>>;
}>;

const BOOLEAN_TRUE_LABEL = 'Yes';
const BOOLEAN_FALSE_LABEL = 'No';

function readFieldType(raw: string): OpenCodeV2FormFieldType | null {
  switch (raw) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'multiselect':
    case 'external':
      return raw;
    default:
      return null;
  }
}

function readOptions(field: Record<string, unknown>): Array<{ label: string; value: string; description: string }> {
  const raw = Array.isArray(field.options) ? field.options : [];
  return raw.flatMap((option) => {
    const record = asRecord(option);
    if (!record) return [];
    // Upstream `Form.Option.value/label` are opaque strings: whitespace and empty are valid.
    // Preserve them verbatim; only skip when either side is not a string.
    if (typeof record.value !== 'string' || typeof record.label !== 'string') return [];
    const value = record.value;
    // Fall back to the value for display when the label is empty so Happier can still surface
    // the option; the exact value is preserved separately for the reply mapping.
    const label = record.label.length > 0 ? record.label : value;
    // Keep even when both are empty so the binding still maps ""->""; the question surface
    // may filter empty display labels but the reply mapping stays exact.
    const description = typeof record.description === 'string' ? record.description : '';
    return [{ label, value, description }];
  });
}

function readDefault(field: Record<string, unknown>, type: OpenCodeV2FormFieldType): OpenCodeV2FormFieldBinding['defaultValue'] {
  const value = field.default;
  if (type === 'multiselect') return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined;
  if (type === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (type === 'number' || type === 'integer') return typeof value === 'number' ? value : undefined;
  return typeof value === 'string' ? value : undefined;
}

function readWhen(field: Record<string, unknown>): OpenCodeV2FormWhen[] {
  const raw = Array.isArray(field.when) ? field.when : [];
  return raw.flatMap((entry) => {
    const record = asRecord(entry);
    const key = record ? normalizeString(record.key) : '';
    const op = record ? normalizeString(record.op) : '';
    if (!record || !key || (op !== 'eq' && op !== 'neq')) return [];
    const value = record.value;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return [];
    return [{ key, op, value }];
  });
}

/** Renders the field's own validation rules so the answer has a chance of passing upstream. */
function readConstraintHint(field: Record<string, unknown>, type: OpenCodeV2FormFieldType): string {
  const parts: string[] = [];
  const num = (key: string): number | null => (typeof field[key] === 'number' ? field[key] as number : null);
  if (type === 'string') {
    const format = normalizeString(field.format);
    if (format) parts.push(`format ${format}`);
    const min = num('minLength');
    const max = num('maxLength');
    if (min !== null) parts.push(`at least ${min} characters`);
    if (max !== null) parts.push(`at most ${max} characters`);
    const pattern = normalizeString(field.pattern);
    if (pattern) parts.push(`matching ${pattern}`);
  }
  if (type === 'number' || type === 'integer') {
    const min = num('minimum');
    const max = num('maximum');
    if (min !== null) parts.push(`minimum ${min}`);
    if (max !== null) parts.push(`maximum ${max}`);
  }
  if (type === 'multiselect') {
    const min = num('minItems');
    const max = num('maxItems');
    if (min !== null) parts.push(`choose at least ${min}`);
    if (max !== null) parts.push(`choose at most ${max}`);
  }
  return parts.join('; ');
}

/**
 * Projects one released `Form.Info` onto Happier's question request shape. Returns null for a
 * payload that cannot be answered, so the caller can fail closed instead of asking an empty
 * question.
 */
export function projectOpenCodeV2Form(rawForm: unknown): OpenCodeV2FormProjection | null {
  const form = asRecord(rawForm);
  if (!form) return null;
  const id = normalizeString(form.id);
  const sessionID = normalizeString(form.sessionID);
  if (!id || !sessionID) return null;

  const title = normalizeString(form.title);
  const rawFields = Array.isArray(form.fields) ? form.fields : [];
  const questions: Array<Record<string, unknown>> = [];
  const bindings: OpenCodeV2FormFieldBinding[] = [];
  const hiddenBindings: OpenCodeV2FormFieldBinding[] = [];
  const unrepresentable: Array<{ key: string; aspect: string }> = [];
  let order = 0;

  for (const rawField of rawFields) {
    const field = asRecord(rawField);
    if (!field) continue;
    const key = normalizeString(field.key);
    const type = readFieldType(normalizeString(field.type));
    if (!key || !type) continue;

    const fieldTitle = normalizeString(field.title);
    const description = normalizeString(field.description);
    const options = type === 'boolean'
      ? [{ label: BOOLEAN_TRUE_LABEL, value: 'true', description: '' }, { label: BOOLEAN_FALSE_LABEL, value: 'false', description: '' }]
      : readOptions(field);
    const when = readWhen(field);
    const defaultValue = readDefault(field, type);
    const binding: OpenCodeV2FormFieldBinding = {
      key,
      type,
      optionValueByLabel: Object.fromEntries(options.map((option) => [option.label, option.value])),
      hidden: field.hidden === true,
      ...(defaultValue === undefined ? {} : { defaultValue }),
      when,
      order: order++,
    };

    if (binding.hidden) {
      // Upstream: "Skip the interactive prompt and use the default unless an answer is supplied."
      hiddenBindings.push(binding);
      continue;
    }

    if (type === 'external') {
      // An external field points at a URL to visit; it carries no answerable value.
      unrepresentable.push({ key, aspect: 'external-url-field' });
    }
    // Released `custom: true` alongside options is the freeform escape hatch: any string is
    // accepted in addition to the listed values (`packages/core/src/form.ts` validateField).
    // Happier's AskUserQuestion expresses exactly that as options plus `freeform`, so it stays
    // representable here and the runtime preserves the incoming freeform marker.
    const allowsCustomFreeform =
      field.custom === true && (type === 'string' || type === 'multiselect') && options.length > 0;

    const constraintHint = readConstraintHint(field, type);
    const externalUrl = type === 'external' ? normalizeString(field.url) : '';
    const questionText = [description || fieldTitle || key, externalUrl, constraintHint ? `(${constraintHint})` : '']
      .filter((part) => part.length > 0)
      .join(' ');

    questions.push({
      // Happier keys answers by question text and falls back to the header, so both must be stable.
      question: questionText,
      header: fieldTitle || key,
      options: options.map((option) => ({
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
      multiple: type === 'multiselect',
      ...(title ? { formTitle: title } : {}),
      // `custom` stays answerable: options plus an explicit freeform marker that the runtime
      // preserves into AskUserQuestion (`allowsFreeform: freeform !== undefined`).
      ...(allowsCustomFreeform ? { freeform: {} } : {}),
    });
    bindings.push(binding);
  }

  if (questions.length === 0 && hiddenBindings.length === 0) return null;
  return { request: { id, sessionID, questions }, bindings, hiddenBindings, unrepresentable };
}

function coerceAnswerValue(
  binding: OpenCodeV2FormFieldBinding,
  labels: readonly string[],
): string | number | boolean | string[] | null {
  const resolve = (label: string): string => binding.optionValueByLabel[label] ?? label;
  if (binding.type === 'multiselect') {
    // Preserve exact string values including "" and whitespace; an empty label list is
    // unanswered and falls back to the declared default via the caller.
    if (labels.length === 0) return null;
    return labels.map(resolve);
  }
  if (labels.length === 0) return null;
  // Preserve the exact first label (including ""/whitespace): upstream treats an absent key
  // as unanswered while an empty string is a real answer for non-required fields.
  const first = labels[0]!;
  const value = resolve(first);
  if (binding.type === 'boolean') {
    // An unrecognized label is not an answer; reporting it as `false` would invent a decision.
    if (value === 'true' || value === BOOLEAN_TRUE_LABEL) return true;
    if (value === 'false' || value === BOOLEAN_FALSE_LABEL) return false;
    return null;
  }
  if (binding.type === 'number' || binding.type === 'integer') {
    // Empty/whitespace is not a number: Number("  ") is 0, which would invent a value.
    if (value.trim().length === 0) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return value;
}

type AnswerValue = string | number | boolean | readonly string[];

/** Upstream `Form.When`: an unanswered referenced field makes the condition false for both ops. */
function conditionHolds(condition: OpenCodeV2FormWhen, answered: ReadonlyMap<string, AnswerValue>): boolean {
  if (!answered.has(condition.key)) return false;
  const value = answered.get(condition.key)!;
  const includes = Array.isArray(value)
    ? value.some((entry) => entry === condition.value)
    : value === condition.value;
  return condition.op === 'eq' ? includes : !includes;
}

/**
 * Rebuilds the upstream `Form.Reply.answer` record from Happier's positional label rows.
 *
 * - Unanswered fields fall back to their declared default and are otherwise omitted: upstream
 *   treats an absent key as unanswered, while an empty string is a real answer that can fail the
 *   field's own validation.
 * - Hidden fields are never asked, so they contribute only their default.
 * - `when` conditions are evaluated against the assembled answers in decoded field declaration
 *   order (`when.key` must reference an earlier field), and an inactive field's answer is dropped
 *   because upstream treats it as neither required nor answerable. Hidden-first evaluation would
 *   falsely deactivate a hidden default that depends on an earlier visible answer.
 */
export function buildOpenCodeV2FormAnswer(
  bindings: ReadonlyArray<OpenCodeV2FormFieldBinding>,
  answers: ReadonlyArray<readonly string[]>,
  hiddenBindings: ReadonlyArray<OpenCodeV2FormFieldBinding> = [],
): Record<string, AnswerValue> {
  const assembled = new Map<string, AnswerValue>();
  for (const binding of hiddenBindings) {
    if (binding.defaultValue !== undefined) assembled.set(binding.key, binding.defaultValue);
  }
  bindings.forEach((binding, index) => {
    const labels = Array.isArray(answers[index]) ? answers[index]! : [];
    const value = coerceAnswerValue(binding, labels) ?? binding.defaultValue ?? null;
    if (value !== null && value !== undefined) assembled.set(binding.key, value);
  });

  // Form keys are opaque released wire strings, including JavaScript prototype names. A null
  // prototype keeps every valid key as own data instead of invoking Object.prototype setters.
  const answer = Object.create(null) as Record<string, AnswerValue>;
  const active = new Map<string, AnswerValue>();
  const ordered = [...hiddenBindings, ...bindings].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const binding of ordered) {
    if (!assembled.has(binding.key)) continue;
    if (!binding.when.every((condition) => conditionHolds(condition, active))) continue;
    const value = assembled.get(binding.key)!;
    active.set(binding.key, value);
    answer[binding.key] = value;
  }
  return answer;
}
