import chalk from 'chalk';

/**
 * The send facts an action error carries in `details` (see the
 * `session.message.send` dependency in createCliActionDeps): which localId the
 * send used, in which session, whether the relay holds it, whether the relay
 * already held it before this attempt, and an explanation.
 */
export type PendingCustodyDetails = Readonly<{
  pendingCustody: string;
  sessionId: string | null;
  localId: string;
  deduplicated: boolean;
  message: string | null;
}>;

export function readPendingCustodyDetails(value: unknown): PendingCustodyDetails | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return typeof record.pendingCustody === 'string' && typeof record.localId === 'string'
    ? {
        pendingCustody: record.pendingCustody,
        sessionId: typeof record.sessionId === 'string' && record.sessionId ? record.sessionId : null,
        localId: record.localId,
        deduplicated: record.deduplicated === true,
        message: typeof record.message === 'string' && record.message.trim() ? record.message : null,
      }
    : null;
}

/** Prints the send facts of a failed send to stderr for human output; prints nothing without them. */
export function printPendingCustodyDetails(value: unknown): void {
  const custody = readPendingCustodyDetails(value);
  if (!custody) return;
  const facts = [
    `pending custody: ${custody.pendingCustody}`,
    ...(custody.sessionId ? [`session: ${custody.sessionId}`] : []),
    ...(custody.deduplicated ? ['already present, deduplicated by localId'] : []),
  ];
  console.error(chalk.yellow('localId:'), custody.localId, `(${facts.join('; ')})`);
  if (custody.message) console.error(custody.message);
}
