import { CLI_ACQUISITION_PROGRESS_EVENT, type CliAcquisitionProgress } from '@happier-dev/protocol';
import type { InteractiveSystemTaskEventInput } from '@happier-dev/cli-common/systemTasks';

/** Both ambient inspection and explicit setup report the same acquisition producer facts. */
export function reportCliAcquisitionProgress(emit: (event: InteractiveSystemTaskEventInput) => void) {
  return (progress: CliAcquisitionProgress): void => emit({
    type: CLI_ACQUISITION_PROGRESS_EVENT,
    stepId: 'setup.thisComputer.ensureCli',
    data: progress,
  });
}
