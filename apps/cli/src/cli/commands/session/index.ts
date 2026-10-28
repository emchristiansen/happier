
import type { CommandContext } from '@/cli/commandRegistry';

export { handleSessionCommand } from './handleSessionCommand';

import { handleSessionCommand } from './handleSessionCommand';
import { fail } from '@happier-dev/cli-common/output';

export async function handleSessionCliCommand(context: CommandContext): Promise<void> {
  try {
    await handleSessionCommand(context.args.slice(1));
  } catch (error) {
    console.error(fail(error instanceof Error ? error.message : 'Unknown error'));
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}
