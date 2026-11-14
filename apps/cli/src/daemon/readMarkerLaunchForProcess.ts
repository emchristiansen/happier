import type { DaemonSessionMarker } from './sessionRegistry';

/**
 * The launch a marker records for the process now at its pid, or undefined. Launch evidence describes
 * one incarnation, so it applies only when the marker's fingerprint and the live process's fingerprint
 * are both known and equal (HPI-40/41). Every reattach constructor reads it through here.
 */
export function readMarkerLaunchForProcess(
  marker: Readonly<Pick<DaemonSessionMarker, 'processInstanceFingerprint' | 'launchedConnectedServices'>>,
  currentProcessInstanceFingerprint: string | undefined,
): unknown {
  return marker.processInstanceFingerprint !== undefined
    && marker.processInstanceFingerprint === currentProcessInstanceFingerprint
    ? marker.launchedConnectedServices
    : undefined;
}
