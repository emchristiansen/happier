import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runCommandSuite, type CommandSuiteEntry } from './lib/runCommandSuite.ts';
import { runYarnCommand } from './lib/runYarnCommand.ts';
import { SHARED_PACKAGE_TEST_COMMANDS } from './lib/sharedPackageTestCommands.ts';

export { SHARED_PACKAGE_TEST_COMMANDS } from './lib/sharedPackageTestCommands.ts';

export interface RunSharedPackageTestsOptions {
  rootDir?: string;
  commands?: readonly CommandSuiteEntry[];
  maxConcurrent?: number;
  runCommand?: (command: CommandSuiteEntry) => Promise<void>;
}

export async function runSharedPackageTests(
  options: RunSharedPackageTestsOptions = {},
): Promise<readonly CommandSuiteEntry[]> {
  const rootDir = options.rootDir ?? process.cwd();
  return runCommandSuite({
    commands: options.commands ?? SHARED_PACKAGE_TEST_COMMANDS,
    maxConcurrent: options.maxConcurrent,
    suiteName: 'Shared package test suite',
    runCommand: options.runCommand ?? ((command) => runYarnCommand(command, rootDir)),
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runSharedPackageTests().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
