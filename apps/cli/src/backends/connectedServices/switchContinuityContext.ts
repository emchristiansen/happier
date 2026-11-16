import type {
  ConnectedServiceResumeContinuityDiagnostics,
  ConnectedServiceSwitchContinuityParams,
} from '@/backends/types';

export const PROVIDER_SESSION_STATE_UNAVAILABLE_FOR_RESUME_REASON =
  'provider_session_state_unavailable_for_resume' as const;

export function hasExactConnectedServiceRestartContinuityContext(
  params: ConnectedServiceSwitchContinuityParams,
): boolean {
  return Boolean(params.connectedServiceMaterializationIdentityV1)
    && typeof params.vendorResumeId === 'string'
    && params.vendorResumeId.trim().length > 0;
}

export function isConnectedToConnectedServiceSwitch(
  params: ConnectedServiceSwitchContinuityParams,
): boolean {
  return params.previousBinding?.source === 'connected' && params.nextBinding.source === 'connected';
}

export function isExactSameConnectedServiceSelection(
  params: ConnectedServiceSwitchContinuityParams,
): boolean {
  return isConnectedToConnectedServiceSwitch(params)
    && params.previousBinding?.serviceId === params.nextBinding.serviceId
    && params.previousBinding.selection === params.nextBinding.selection
    && params.previousBinding.profileId === params.nextBinding.profileId
    && params.previousBinding.groupId === params.nextBinding.groupId;
}

export function isSameConnectedServiceAuthGroup(
  params: ConnectedServiceSwitchContinuityParams,
): boolean {
  return isConnectedToConnectedServiceSwitch(params)
    && params.previousBinding?.selection === 'group'
    && params.nextBinding.selection === 'group'
    && params.previousBinding.serviceId === params.nextBinding.serviceId
    && params.previousBinding.groupId !== null
    && params.previousBinding.groupId === params.nextBinding.groupId;
}

/**
 * Whether the runner being switched is on a per_session_softmax member's own home rather than the
 * group's shared home: its current binding still carries per-session ownership (an applied member, or
 * a pending target on a member home). Such a runner does not read the shared group home, so writing
 * the group home never applies a switch to it (T12-CONV-01); only a restart onto the target home does.
 */
export function isPerSessionMemberHomeRunner(params: ConnectedServiceSwitchContinuityParams): boolean {
  const binding = params.fromBindings.bindingsByServiceId?.[params.serviceId];
  if (!binding || binding.source !== 'connected' || binding.selection !== 'group') return false;
  if (binding.member) return true;
  return Boolean(binding.materializedAssignment && binding.materializedAssignment.home !== 'group');
}

export function providerSessionStateUnavailableForResume(input: Readonly<{
  diagnostics?: ConnectedServiceResumeContinuityDiagnostics;
}> = {}) {
  return {
    mode: 'unsupported',
    reason: PROVIDER_SESSION_STATE_UNAVAILABLE_FOR_RESUME_REASON,
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  } as const;
}
