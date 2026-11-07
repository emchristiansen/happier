import type { SessionConnectedServiceAuthCurrentGroupTruthV1 } from '@happier-dev/protocol';

export class ClaudeConnectedServiceAuthGroupRequestFence {
  private currentTruth: SessionConnectedServiceAuthCurrentGroupTruthV1 | null = null;
  private unavailable: Extract<SessionConnectedServiceAuthCurrentGroupTruthV1, {
    kind: 'current_auth_group_unavailable';
  }> | null = null;
  private waiters = new Set<() => void>();

  applyCurrentTruth(truth: SessionConnectedServiceAuthCurrentGroupTruthV1): void {
    this.currentTruth = truth;
    if (truth.kind === 'current_auth_group_unavailable') {
      this.unavailable = truth;
      return;
    }
    this.unavailable = null;
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  readCurrentTruth(): SessionConnectedServiceAuthCurrentGroupTruthV1 | null {
    return this.currentTruth;
  }

  async waitUntilAvailable(signal: AbortSignal): Promise<void> {
    while (this.unavailable) {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          this.waiters.delete(onAvailable);
          reject(signal.reason);
        };
        const onAvailable = () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        this.waiters.add(onAvailable);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
  }
}
