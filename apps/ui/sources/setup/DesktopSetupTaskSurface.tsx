import * as React from 'react';

import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import { useSystemTaskSnapshot } from '@/components/systemTasks/useSystemTaskSnapshot';

import { SetupSurface } from './SetupSurface';

/** Byte samples subscribe at the visible leaf, not in the gate's readiness effects or shell. */
export function DesktopSetupTaskSurface(props: React.ComponentProps<typeof SetupSurface> & Readonly<{ inspectionTaskId: string | null }>) {
    const { inspectionTaskId, ...surfaceProps } = props;
    const inspectionRun = useSystemTaskSnapshot(getSystemTasksRunner(), inspectionTaskId);
    return <SetupSurface {...surfaceProps} run={inspectionTaskId ? inspectionRun : props.run} />;
}
