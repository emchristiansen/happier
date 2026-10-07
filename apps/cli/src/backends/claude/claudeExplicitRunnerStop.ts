import type { RunnerTerminationEvent } from '@/agent/runtime/runnerTerminationOutcome';

export async function requestClaudeExplicitRunnerStop(input: Readonly<{
  unifiedTerminalEnabled: boolean;
  stopTerminalHostForExplicitStop: (() => Promise<void>) | null;
  requestTermination: (event: RunnerTerminationEvent) => void;
  whenTerminated: Promise<unknown>;
}>): Promise<void> {
  if (input.unifiedTerminalEnabled) {
    if (!input.stopTerminalHostForExplicitStop) {
      throw new Error('Claude Unified exact terminal-host stop is unavailable');
    }
    await input.stopTerminalHostForExplicitStop();
  }

  input.requestTermination({ kind: 'killSession' });
  await input.whenTerminated;
}
