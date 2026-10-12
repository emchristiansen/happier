import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runCommandSuite, type CommandSuiteEntry } from './lib/runCommandSuite.ts';
import { runYarnCommand } from './lib/runYarnCommand.ts';

export const ROOT_TYPECHECK_COMMANDS = [
  { id: 'privacy-kit', args: ['workspace', 'privacy-kit', 'typecheck'] },
  { id: 'protocol', args: ['workspace', '@happier-dev/protocol', 'typecheck'] },
  { id: 'transfers', args: ['workspace', '@happier-dev/transfers', 'typecheck'] },
  { id: 'agents', args: ['workspace', '@happier-dev/agents', 'typecheck'] },
  { id: 'cli-common', args: ['workspace', '@happier-dev/cli-common', 'typecheck'] },
  { id: 'connection-supervisor', args: ['workspace', '@happier-dev/connection-supervisor', 'typecheck'] },
  { id: 'bootstrap', args: ['workspace', '@happier-dev/bootstrap', 'typecheck'] },
  { id: 'app', args: ['workspace', '@happier-dev/app', 'typecheck'] },
  { id: 'cli', args: ['workspace', '@happier-dev/cli', 'typecheck'] },
  { id: 'server', args: ['--cwd', 'apps/server', 'typecheck'] },
  { id: 'tests', args: ['workspace', '@happier-dev/tests', 'typecheck'] },
] as const satisfies readonly CommandSuiteEntry[];

export interface RunRootTypecheckOptions {
  rootDir?: string;
  commands?: readonly CommandSuiteEntry[];
  runCommand?: (command: CommandSuiteEntry) => Promise<void>;
}

export async function runRootTypecheck(
  options: RunRootTypecheckOptions = {},
): Promise<readonly CommandSuiteEntry[]> {
  const rootDir = options.rootDir ?? process.cwd();
  const commands = options.commands ?? ROOT_TYPECHECK_COMMANDS;
  return runCommandSuite({
    commands,
    maxConcurrent: 1,
    suiteName: 'Root typecheck suite',
    runCommand: options.runCommand ?? ((command) => runYarnCommand(command, rootDir)),
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runRootTypecheck().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
