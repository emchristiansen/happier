import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runCommandSuite, type CommandSuiteEntry } from './lib/runCommandSuite.ts';
import { runYarnCommand } from './lib/runYarnCommand.ts';

const commands = {
  unit: [
    { id: 'shared-packages', args: ['-s', 'test:shared-packages:local'] },
    { id: 'ui', args: ['workspace', '@happier-dev/app', 'test'] },
    { id: 'cli', args: ['workspace', '@happier-dev/cli', 'test:unit'] },
    { id: 'server', args: ['--cwd', 'apps/server', 'test:unit'] },
    { id: 'stack', args: ['--cwd', 'apps/stack', 'test:unit'] },
  ],
  integration: [
    { id: 'ui', args: ['workspace', '@happier-dev/app', 'test:integration'] },
    { id: 'cli', args: ['workspace', '@happier-dev/cli', 'test:integration'] },
    { id: 'server', args: ['--cwd', 'apps/server', 'test:integration'] },
    { id: 'stack', args: ['--cwd', 'apps/stack', 'test:integration'] },
  ],
} as const satisfies Record<string, readonly CommandSuiteEntry[]>;

export async function runRootTests(lane: string): Promise<void> {
  if (lane !== 'unit' && lane !== 'integration') throw new Error('Test lane must be unit or integration');
  await runCommandSuite<CommandSuiteEntry>({
    commands: commands[lane],
    suiteName: `Root ${lane} test suite`,
    runCommand: (command) => runYarnCommand(command, process.cwd()),
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runRootTests(process.argv[2]).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
