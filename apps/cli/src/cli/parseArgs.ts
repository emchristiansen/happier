import { parseAndStripTerminalRuntimeFlags, type TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';
import { parseRuntimeContextPrefixArgs } from '@/utils/env/runtimeContextArgv';

function isCliEntrypointPath(arg: string): boolean {
    const normalized = String(arg ?? '').trim().replaceAll('\\', '/');
    if (!normalized) return false;
    return (
        normalized.endsWith('/package-dist/index.mjs') ||
        normalized.endsWith('/dist/index.mjs') ||
        normalized.endsWith('/apps/cli/src/index.ts')
    );
}

export function normalizeCliArgv(argv: readonly string[]): string[] {
    if (argv.length === 0) return [];
    return isCliEntrypointPath(argv[0] ?? '') ? [...argv.slice(1)] : [...argv];
}

/** Node and compiled Bun both retain an executable and entrypoint before command arguments. */
export function readCliProcessArgs(argv: readonly string[] = process.argv): string[] {
    return normalizeCliArgv(argv.slice(2));
}

export function parseCliArgs(argv: string[]): Readonly<{
  args: string[];
  terminalRuntime: TerminalRuntimeFlags | null;
}> {
  const { args } = parseRuntimeContextPrefixArgs(normalizeCliArgv(argv));
  const parsed = parseAndStripTerminalRuntimeFlags(args);
  return { args: parsed.argv, terminalRuntime: parsed.terminal };
}
