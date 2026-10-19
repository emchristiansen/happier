import type { RunnerTerminationEvent } from '@/agent/runtime/runnerTerminationOutcome';

export async function requestClaudeExplicitRunnerStop(input: Readonly<{
  unifiedTerminalEnabled: boolean;
  destroyOwnedHostForExplicitStop: (() => Promise<void>) | null;
  requestTermination: (event: RunnerTerminationEvent) => void;
  whenTerminated: Promise<unknown>;
  terminationEvent?: RunnerTerminationEvent;
}>): Promise<void> {
  if (input.unifiedTerminalEnabled) {
    if (!input.destroyOwnedHostForExplicitStop) {
      throw new Error('Claude Unified exact terminal-host disposal is unavailable');
    }
    await input.destroyOwnedHostForExplicitStop();
  }

  input.requestTermination(input.terminationEvent ?? { kind: 'killSession' });
  await input.whenTerminated;
}
