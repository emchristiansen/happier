import { claudeCliFlagCanConsumeNextArg } from './flagArity';

/** A Claude CLI flag with its value, when it takes one (`['--model', 'x']`, `['--model=x']`, `['--verbose']`). */
export type ClaudeFlagGroup = readonly string[];

export type ClaudeLaunchArgs = Readonly<{
    flagGroups: readonly ClaudeFlagGroup[];
    positionalArgs: readonly string[];
    hasExplicitPositionalDelimiter: boolean;
}>;

/**
 * Split a raw Claude argv into flag groups and positional arguments using the CLI's flag arity,
 * so an option value (an opaque system prompt or session name, say) is never read as a flag.
 */
export function splitClaudeLaunchArgs(args: readonly string[]): ClaudeLaunchArgs {
    const flagGroups: ClaudeFlagGroup[] = [];
    const positionalArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === '--') {
            positionalArgs.push(...args.slice(i + 1));
            return { flagGroups, positionalArgs, hasExplicitPositionalDelimiter: true };
        }
        if (!arg.startsWith('-')) {
            positionalArgs.push(arg);
            continue;
        }
        const next = args[i + 1];
        if (claudeCliFlagCanConsumeNextArg(arg, next)) {
            flagGroups.push([arg, next!]);
            i++;
        } else {
            flagGroups.push([arg]);
        }
    }
    return { flagGroups, positionalArgs, hasExplicitPositionalDelimiter: false };
}

function flagName(group: ClaudeFlagGroup): string {
    const flag = group[0] ?? '';
    const equals = flag.indexOf('=');
    return equals > 0 ? flag.slice(0, equals) : flag;
}

function flagValue(group: ClaudeFlagGroup): string | undefined {
    const flag = group[0] ?? '';
    const equals = flag.indexOf('=');
    return equals > 0 ? flag.slice(equals + 1) : group[1];
}

/** The model named by the last real `--model` flag, as Claude Code reads it. */
export function readClaudeModelFlag(groups: readonly ClaudeFlagGroup[]): string | undefined {
    let model: string | undefined;
    for (const group of groups) {
        if (flagName(group) === '--model') model = flagValue(group);
    }
    return model;
}

export function withoutClaudeFlag(groups: readonly ClaudeFlagGroup[], flag: string): ClaudeFlagGroup[] {
    return groups.filter((group) => flagName(group) !== flag);
}

/** Replace every `--model` flag with one naming `model`. */
export function replaceClaudeModelFlag(groups: readonly ClaudeFlagGroup[], model: string): ClaudeFlagGroup[] {
    return [...withoutClaudeFlag(groups, '--model'), ['--model', model]];
}

// The launch inputs, besides the environment, that decide which model Claude Code resolves
// (observed on native 2.1.280: `--model`, a settings `model`, `--setting-sources` and an agent's
// `model` each change `get_settings.applied.model`).
const MODEL_RESOLUTION_FLAGS = new Set(['--model', '--settings', '--setting-sources', '--agent', '--agents']);

/** Only the flags that decide the resolved model; never prompts, sessions, MCP servers or plugins. */
export function selectClaudeModelResolutionArgs(groups: readonly ClaudeFlagGroup[]): string[] {
    return groups.filter((group) => MODEL_RESOLUTION_FLAGS.has(flagName(group))).flat();
}
