import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';

import type { DurableRecoveryStore, TransactionalRecoveryStore } from './DurableBackoffRecoveryScheduler';

type RecoveryIntentFileSnapshot = Readonly<{
  v: 1;
  intentsBySessionId: Readonly<Record<string, unknown>>;
  effectClaimsByRecoveryKey?: Readonly<Record<string, string>>;
}>;

const lockAcquireTimeoutMs = 10_000;
const staleLockAfterMs = 30_000;

type RecoveryIntentFileStoreOptions = Readonly<{
  lockAcquireTimeoutMs?: number;
  staleLockAfterMs?: number;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function normalizeSnapshot(value: unknown): RecoveryIntentFileSnapshot | null {
  if (!isRecord(value) || value.v !== 1 || !isRecord(value.intentsBySessionId)) return null;
  const effectClaimsByRecoveryKey = isRecord(value.effectClaimsByRecoveryKey)
    ? Object.fromEntries(Object.entries(value.effectClaimsByRecoveryKey).filter((entry): entry is [string, string] => (
      entry[0].trim().length > 0 && typeof entry[1] === 'string' && entry[1].trim().length > 0
    )))
    : undefined;
  return {
    v: 1,
    intentsBySessionId: value.intentsBySessionId,
    ...(effectClaimsByRecoveryKey && Object.keys(effectClaimsByRecoveryKey).length > 0
      ? { effectClaimsByRecoveryKey }
      : {}),
  };
}

async function bestEffortChmod0600(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  await chmod(path, 0o600).catch(() => {});
}

function resolveLockPath(filePath: string): string {
  return `${filePath}.lock`;
}

async function withRecoveryIntentFileLock<TResult>(
  filePath: string,
  effect: () => Promise<TResult>,
  options: RecoveryIntentFileStoreOptions,
): Promise<TResult> {
  return await withJsonOwnerFileLock({
    lockPath: resolveLockPath(filePath),
    timeoutMs: options.lockAcquireTimeoutMs ?? lockAcquireTimeoutMs,
    staleAfterMs: options.staleLockAfterMs ?? staleLockAfterMs,
    errorCode: 'recovery_intent_file_store_lock_timeout',
  }, effect);
}

export function createRecoveryIntentFileStore<TIntent>(
  filePath: string,
  options: RecoveryIntentFileStoreOptions = {},
): TransactionalRecoveryStore<TIntent> {
  let persistSequence = 0;
  let writeQueue: Promise<void> = Promise.resolve();
  const intentsByRecoveryKey = new Map<string, unknown>();
  const effectClaimsByRecoveryKey = new Map<string, string>();

  const loadFresh = (): void => {
    intentsByRecoveryKey.clear();
    effectClaimsByRecoveryKey.clear();
    try {
      if (!existsSync(filePath)) return;
      const parsed = normalizeSnapshot(JSON.parse(readFileSync(filePath, 'utf8')) as unknown);
      if (!parsed) return;
      for (const [recoveryKey, intent] of Object.entries(parsed.intentsBySessionId)) {
        if (recoveryKey.trim().length === 0) continue;
        intentsByRecoveryKey.set(recoveryKey, intent);
      }
      for (const [recoveryKey, token] of Object.entries(parsed.effectClaimsByRecoveryKey ?? {})) {
        if (!intentsByRecoveryKey.has(recoveryKey)) continue;
        effectClaimsByRecoveryKey.set(recoveryKey, token);
      }
    } catch {
      intentsByRecoveryKey.clear();
      effectClaimsByRecoveryKey.clear();
    }
  };

  const persist = async (): Promise<void> => {
    persistSequence += 1;
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${persistSequence}.tmp`;
    const claims = Object.fromEntries(effectClaimsByRecoveryKey.entries());
    const snapshot: RecoveryIntentFileSnapshot = {
      v: 1,
      intentsBySessionId: Object.fromEntries(intentsByRecoveryKey.entries()),
      ...(Object.keys(claims).length > 0 ? { effectClaimsByRecoveryKey: claims } : {}),
    };
    await mkdir(dirname(filePath), { recursive: true });
    try {
      await writeFile(tmpPath, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
      await rename(tmpPath, filePath);
      await bestEffortChmod0600(filePath);
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  };

  const enqueueMutation = async <TResult>(mutation: () => Promise<TResult>): Promise<TResult> => {
    let result!: TResult;
    const run = writeQueue.catch(() => undefined).then(async () => {
      result = await withRecoveryIntentFileLock(filePath, async () => {
        loadFresh();
        return await mutation();
      }, options);
    });
    writeQueue = run.catch(() => undefined);
    await run;
    return result;
  };

  const transact: NonNullable<DurableRecoveryStore<TIntent>['transact']> = async (
    recoveryKey,
    transaction,
  ) => await enqueueMutation(async () => {
    const currentIntent = (intentsByRecoveryKey.get(recoveryKey) as TIntent | undefined) ?? null;
    const next = transaction({
      intent: currentIntent,
      effectClaimToken: effectClaimsByRecoveryKey.get(recoveryKey) ?? null,
    });
    if (next.intent === null) {
      intentsByRecoveryKey.delete(recoveryKey);
      effectClaimsByRecoveryKey.delete(recoveryKey);
    } else {
      intentsByRecoveryKey.set(recoveryKey, next.intent);
      if (next.effectClaimToken === null) effectClaimsByRecoveryKey.delete(recoveryKey);
      else effectClaimsByRecoveryKey.set(recoveryKey, next.effectClaimToken);
    }
    await persist();
    return next.result;
  });

  return {
    read: (recoveryKey) => {
      loadFresh();
      return intentsByRecoveryKey.get(recoveryKey) ?? null;
    },
    readAll: () => {
      loadFresh();
      return Array.from(intentsByRecoveryKey.entries());
    },
    write: async (recoveryKey, intent) => {
      await transact(recoveryKey, (current) => ({
        intent,
        effectClaimToken: current.effectClaimToken,
        result: undefined,
      }));
    },
    merge: async (recoveryKey, next, merge) => await transact(recoveryKey, (current) => {
      const intent = merge(current.intent, next);
      return {
        intent,
        effectClaimToken: current.effectClaimToken,
        result: intent,
      };
    }),
    transact,
    remove: async (recoveryKey) => {
      await transact(recoveryKey, () => ({
        intent: null,
        effectClaimToken: null,
        result: undefined,
      }));
    },
    prune: async (predicate) => await enqueueMutation(async () => {
      const prunedRecoveryKeys: string[] = [];
      for (const [recoveryKey, value] of intentsByRecoveryKey.entries()) {
        if (!predicate({ recoveryKey, value })) continue;
        intentsByRecoveryKey.delete(recoveryKey);
        effectClaimsByRecoveryKey.delete(recoveryKey);
        prunedRecoveryKeys.push(recoveryKey);
      }
      if (prunedRecoveryKeys.length > 0) await persist();
      return prunedRecoveryKeys;
    }),
  };
}
