export function readLinuxProcProcessInstanceFingerprintSync(
  pid: number,
  options?: Readonly<{ readFileSyncImpl?: typeof import('node:fs').readFileSync }>,
): string | null;

export function readProcessInstanceFingerprintSync(
  pid: number,
  options?: Readonly<{
    platform?: NodeJS.Platform;
    spawnSyncImpl?: typeof import('node:child_process').spawnSync;
    readFileSyncImpl?: typeof import('node:fs').readFileSync;
  }>,
): string | null;

export function processInstanceFingerprintMatches(expected: unknown, observed: unknown): boolean;
