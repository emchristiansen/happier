import type { BackgroundServiceRepairPlan } from '@/diagnostics/backgroundServiceRepair/types';
import { muted, severity } from '@/ui/format/styles';

/**
 * Every background service the repair plan removes, by label and definition path. Accepting any
 * automatic-startup finding applies the whole plan, so the removals are named here — before
 * consent in the guided flow and before `--yes` applies — rather than left to the findings.
 */
export function renderPlannedServiceRemovals(plan: BackgroundServiceRepairPlan): string[] {
  const removals = plan.actions.flatMap((action) => action.kind === 'remove-service' ? [action.service] : []);
  if (removals.length === 0) return [];
  return [
    severity.action('This repair removes these background services:'),
    ...removals.map((service) => `  • ${service.label} ${muted(`(${service.targetMode}, ${service.installedPath})`)}`),
  ];
}
