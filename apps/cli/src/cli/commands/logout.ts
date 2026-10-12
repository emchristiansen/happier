import { cmd, errorFrame, warn } from '@happier-dev/cli-common/output';

import { handleAuthCommand } from '@/cli/commands/auth';

import type { CommandContext } from '@/cli/commandRegistry';

export async function handleLogoutCliCommand(_context: CommandContext): Promise<void> {
  console.log(`${warn(`${cmd('happier logout')} is deprecated. Use ${cmd('happier auth logout')} instead.`)}\n`);
  try {
    await handleAuthCommand(['logout']);
  } catch (error) {
    console.error(errorFrame('Sign-out failed', [error instanceof Error ? error.message : 'Unknown error']));
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}
