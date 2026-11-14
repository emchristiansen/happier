import { configuration } from '@/configuration';
import {
  createRuntimeAuthAttemptAccountJoinJournal,
  foldRuntimeAuthAttemptAccountJoins,
  type RuntimeAuthAttemptAccountJoinJournal,
} from '@/daemon/connectedServices/runtimeAuth/runtimeAuthAttemptAccountJoin';

/** `happier connect attempt-accounts [--session <id>] [--attempt <id>]`: JSON view of the journal. */
export async function runConnectAttemptAccountsCommand(input: Readonly<{
  args: ReadonlyArray<string>;
  journal?: RuntimeAuthAttemptAccountJoinJournal;
  write: (line: string) => void;
}>): Promise<void> {
  const flag = (name: string): string | null => {
    const index = input.args.indexOf(name);
    if (index === -1) return null;
    const value = input.args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    return value;
  };
  const sessionId = flag('--session');
  const attemptId = flag('--attempt');
  const journal = input.journal ?? createRuntimeAuthAttemptAccountJoinJournal({
    filePath: configuration.connectedServiceRuntimeAuthAttemptAccountsFile,
  });
  const read = await journal.read();
  const attempts = foldRuntimeAuthAttemptAccountJoins(read.events)
    .filter((join) => (sessionId === null || join.sessionId === sessionId) && (attemptId === null || join.attemptId === attemptId));
  input.write(JSON.stringify({ attempts, invalidLines: read.invalidLines }, null, 2));
}
