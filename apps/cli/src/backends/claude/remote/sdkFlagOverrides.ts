import { claudeCliFlagCanConsumeNextArg } from '../cli/flagArity';

export type ClaudeSdkFlagOverrides = {
  maxTurns?: number;
  strictMcpConfig?: boolean;
  appendSystemPrompt?: string;
  customSystemPrompt?: string;
  model?: string;
  fallbackModel?: string;
  effort?: string;
};

export function parseClaudeSdkFlagOverridesFromArgs(args?: string[]): ClaudeSdkFlagOverrides {
  const input = args ?? [];
  let maxTurns: number | undefined;
  let strictMcpConfig: boolean | undefined;
  let appendSystemPrompt: string | undefined;
  let customSystemPrompt: string | undefined;
  let model: string | undefined;
  let fallbackModel: string | undefined;
  let effort: string | undefined;

  // Claude Code takes the next token as the value of a flag that requires one, even when it
  // starts with `-` (an opaque system prompt, say), so values are read by the CLI's flag arity.
  const nextValue = (index: number): string | undefined => {
    const next = index + 1 < input.length ? input[index + 1] : undefined;
    return claudeCliFlagCanConsumeNextArg(input[index]!, next) ? next : undefined;
  };

  const inlineValue = (arg: string, flag: string): string | undefined => {
    if (!arg.startsWith(`${flag}=`)) return undefined;
    const value = arg.slice(flag.length + 1).trim();
    return value || undefined;
  };

  for (let i = 0; i < input.length; i++) {
    const arg = input[i];

    const inlineMaxTurns = inlineValue(arg, '--max-turns');
    if (arg === '--max-turns' || inlineMaxTurns !== undefined) {
      const next = nextValue(i);
      const rawValue = inlineMaxTurns ?? next;
      if (typeof rawValue === 'string') {
        const parsed = Number.parseInt(rawValue, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          maxTurns = parsed;
        }
        if (inlineMaxTurns === undefined) i++;
      }
      continue;
    }

    if (arg === '--strict-mcp-config') {
      strictMcpConfig = true;
      continue;
    }

    const inlineAppendSystemPrompt = inlineValue(arg, '--append-system-prompt');
    if (arg === '--append-system-prompt' || inlineAppendSystemPrompt !== undefined) {
      const next = nextValue(i);
      const rawValue = inlineAppendSystemPrompt ?? next;
      if (typeof rawValue === 'string') {
        appendSystemPrompt = rawValue;
        if (inlineAppendSystemPrompt === undefined) i++;
      }
      continue;
    }

    const inlineSystemPrompt = inlineValue(arg, '--system-prompt');
    if (arg === '--system-prompt' || inlineSystemPrompt !== undefined) {
      const next = nextValue(i);
      const rawValue = inlineSystemPrompt ?? next;
      if (typeof rawValue === 'string') {
        customSystemPrompt = rawValue;
        if (inlineSystemPrompt === undefined) i++;
      }
      continue;
    }

    const inlineModel = inlineValue(arg, '--model');
    if (arg === '--model' || inlineModel !== undefined) {
      const next = nextValue(i);
      const rawValue = inlineModel ?? next;
      if (typeof rawValue === 'string') {
        model = rawValue;
        if (inlineModel === undefined) i++;
      }
      continue;
    }

    const inlineFallbackModel = inlineValue(arg, '--fallback-model');
    if (arg === '--fallback-model' || inlineFallbackModel !== undefined) {
      const next = nextValue(i);
      const rawValue = inlineFallbackModel ?? next;
      if (typeof rawValue === 'string') {
        fallbackModel = rawValue;
        if (inlineFallbackModel === undefined) i++;
      }
      continue;
    }

    const inlineEffort = inlineValue(arg, '--effort');
    if (arg === '--effort' || inlineEffort !== undefined) {
      const next = nextValue(i);
      const rawValue = inlineEffort ?? next;
      if (typeof rawValue === 'string') {
        effort = rawValue;
        if (inlineEffort === undefined) i++;
      }
      continue;
    }

    // Any other flag's value is opaque: never read it as one of the flags above.
    if (arg.startsWith('-') && nextValue(i) !== undefined) i++;
  }

  return {
    maxTurns,
    strictMcpConfig,
    appendSystemPrompt,
    customSystemPrompt,
    model,
    fallbackModel,
    effort,
  };
}
