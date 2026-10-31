import type {
  TerminalHostKind,
  TerminalInputInjectionResult,
} from '@happier-dev/agents';
import type { TerminalHostLiveness } from '@/integrations/terminalHost/_types';

import { logger as defaultLogger } from '@/ui/logger';

type LoggerLike = Readonly<{
  debug(message: string, ...args: unknown[]): void;
}>;

type TelemetryReason = string;

export type ClaudeUnifiedTelemetryEvent =
  | Readonly<{
      name: 'unified.session.host_resolved';
      properties: Readonly<{
        kind: TerminalHostKind | 'disabled';
        platform: NodeJS.Platform;
        preference: 'auto' | TerminalHostKind;
        reason: TelemetryReason;
      }>;
    }>
    | Readonly<{
      name: 'unified.injection.outcome';
      properties: Readonly<{
          status: TerminalInputInjectionResult['status'];
          reason?: TelemetryReason | undefined;
          phase?: string | undefined;
          duplicateRisk?: string | undefined;
          recoverable?: boolean | undefined;
          hostKind: TerminalHostKind;
          multiline: boolean;
          inputByteLength?: number | undefined;
          inputNewlineCount?: number | undefined;
          writeTimeoutMs?: number | undefined;
          originKind: 'ui_pending' | 'ui_immediate' | 'goal_control';
          inFlightSteer?: boolean | undefined;
        }>;
      }>
    | Readonly<{
        name: 'unified.steer.decision';
        properties: Readonly<{
          decision:
            | 'safe'
            | 'vetoed'
            | 'acceptance_armed'
            | 'queued_banner_check'
            // Lane X (incident cmq8y3nlx): bounded own-leftover composer clear + one-shot
            // starvation escalation leave explicit log evidence (the incident's veto loop had
            // no draft evidence at all).
            | 'own_draft_clear_attempted'
            | 'starvation_escalated';
          reason?: TelemetryReason | undefined;
          originKind: 'ui_pending' | 'ui_immediate' | 'goal_control';
          queuedBannerVisible?: boolean | undefined;
          composerDraftPresent?: boolean | undefined;
          /** Length of the composer draft blocking a steer (`user_draft` evidence, lane X). */
          draftLength?: number | undefined;
          /** True when the blocking draft exactly matches a text the runtime itself wrote. */
          ownDraft?: boolean | undefined;
          consecutiveVetoes?: number | undefined;
        }>;
      }>
    | Readonly<{
        // C11: pre-injection composer guard outcome (own leftover cleared / genuine draft deferral).
        name: 'unified.injection.draft_guard';
        properties: Readonly<{
          status:
            | 'cleared'
            | 'foreign_draft'
            | 'capture_style_unavailable'
            | 'provider_unavailable'
            | 'blocked_non_input_state'
            | 'generating'
            | 'capture_failed'
            | 'clear_failed'
            | 'starvation_escalated';
          attempts?: number | undefined;
          draftLength?: number | undefined;
          blockedReason?: TelemetryReason | undefined;
          guardStatus?:
            | 'foreign_draft'
            | 'capture_style_unavailable'
            | 'clear_failed'
            | 'blocked_non_input_state'
            | undefined;
          consecutiveDeferrals?: number | undefined;
          originKind: 'ui_pending' | 'ui_immediate' | 'goal_control';
        }>;
      }>
    | Readonly<{
        name: 'unified.session.host_dead';
        properties: Readonly<{
          hostKind: TerminalHostKind;
          sessionName: string;
          paneId?: string | undefined;
          paneAlive: boolean;
            paneDead?: boolean | undefined;
            panePid?: number | undefined;
            paneCurrentCommand?: string | undefined;
            paneExitStatus?: number | undefined;
            paneScreenDumpCaptured?: boolean | undefined;
            paneScreenDumpTruncated?: boolean | undefined;
            paneScreenDumpErrorCaptured?: boolean | undefined;
            observedAt: number;
          }>;
        }>
    | Readonly<{
        name: 'unified.lifecycle.gap_detected';
      properties: Readonly<{
        source: 'fd3_fetch_fallback';
        signal: 'fetch_start' | 'fetch_idle_clear';
        activeFetchCount: number;
      }>;
    }>
  | Readonly<{
      // Incident cmr377jsr (S1-F1): the bounded turn-end idle re-arm exhausted with a dialog still
      // unresolved. Emitted once per episode so a residual silent-hang is observable, not silent.
      name: 'unified.dialog.turn_end_idle_starvation';
      properties: Readonly<{
        shots: number;
        windowMs: number;
      }>;
    }>
  | Readonly<{
      // Incident cmr3dpuka (S2-b): the mid-turn stall probe budget exhausted while the turn stayed
      // active-but-stuck (e.g. an API-retry loop that never reaches turn-terminal), so a dialog stuck
      // on the mid-turn screen (Fable safeguard chooser) went undetected. Emitted once per stall
      // episode so the residual stuck-turn is observable — the mid-turn analog of the turn-end tail.
      name: 'unified.dialog.turn_stall_starvation';
      properties: Readonly<{
        attempts: number;
        windowMs: number;
      }>;
    }>
  | Readonly<{
      name: 'unified.session.windows_guard_triggered';
      properties: Readonly<{
        guard:
          | 'windows_arm64_unsupported'
          | 'windows_zellij_unvalidated'
          | 'windows_default_shell_cmd';
        hostKind: 'zellij';
        platform: 'win32';
      }>;
    }>;

export type ClaudeUnifiedTelemetrySink = Readonly<{
  emit(event: ClaudeUnifiedTelemetryEvent): void;
}>;

function sanitizeReason(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, '_').slice(0, 80);
  return normalized.length > 0 ? normalized : 'unknown';
}

function buildLogPayload(event: ClaudeUnifiedTelemetryEvent): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    event: event.name,
    ...event.properties,
  };
  if (typeof payload.reason === 'string') {
    payload.reason = sanitizeReason(payload.reason);
  }
  return payload;
}

function normalizeNonNegativeInteger(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.trunc(value));
}

export function createClaudeUnifiedTelemetrySink(params?: Readonly<{
  logger?: LoggerLike | undefined;
}>): ClaudeUnifiedTelemetrySink {
  const logger = params?.logger ?? defaultLogger;
  return {
    emit(event) {
      logger.debug('[claude-unified-telemetry]', buildLogPayload(event));
    },
  };
}

export function emitClaudeUnifiedInjectionOutcome(
  telemetry: ClaudeUnifiedTelemetrySink,
  params: Readonly<{
    result: TerminalInputInjectionResult;
    hostKind: TerminalHostKind;
    multiline: boolean;
    inputByteLength?: number | undefined;
    inputNewlineCount?: number | undefined;
    writeTimeoutMs?: number | undefined;
    originKind: 'ui_pending' | 'ui_immediate' | 'goal_control';
    inFlightSteer?: boolean | undefined;
  }>,
): void {
  const inputByteLength = normalizeNonNegativeInteger(params.inputByteLength);
  const inputNewlineCount = normalizeNonNegativeInteger(params.inputNewlineCount);
  const writeTimeoutMs = normalizeNonNegativeInteger(params.writeTimeoutMs);

  telemetry.emit({
    name: 'unified.injection.outcome',
    properties: {
      status: params.result.status,
      ...(params.result.status === 'injected' ? {} : { reason: params.result.reason }),
      ...(params.result.status === 'failed'
        ? {
            phase: params.result.phase,
            duplicateRisk: params.result.duplicateRisk,
            recoverable: params.result.recoverable,
          }
        : {}),
      hostKind: params.hostKind,
      multiline: params.multiline,
      ...(inputByteLength !== undefined ? { inputByteLength } : {}),
      ...(inputNewlineCount !== undefined ? { inputNewlineCount } : {}),
      ...(writeTimeoutMs !== undefined ? { writeTimeoutMs } : {}),
      originKind: params.originKind,
      ...(params.inFlightSteer ? { inFlightSteer: true } : {}),
    },
  });
}

/**
 * Observability for in-flight steering (D19): every steer evaluation (safe/vetoed + reason),
 * acceptance arming at turn end, and the optional queued-message banner diagnostic emit a line so
 * a steered-or-held prompt always leaves log evidence (incident cmq8171vw had none).
 */
export function emitClaudeUnifiedInjectionDraftGuard(
  telemetry: ClaudeUnifiedTelemetrySink,
  properties: Extract<ClaudeUnifiedTelemetryEvent, { name: 'unified.injection.draft_guard' }>['properties'],
): void {
  telemetry.emit({
    name: 'unified.injection.draft_guard',
    properties,
  });
}

export function emitClaudeUnifiedSteerDecision(
  telemetry: ClaudeUnifiedTelemetrySink,
  properties: Extract<ClaudeUnifiedTelemetryEvent, { name: 'unified.steer.decision' }>['properties'],
): void {
  telemetry.emit({
    name: 'unified.steer.decision',
    properties,
  });
}

export function emitClaudeUnifiedLifecycleGapDetected(
  telemetry: ClaudeUnifiedTelemetrySink,
  properties: Extract<ClaudeUnifiedTelemetryEvent, { name: 'unified.lifecycle.gap_detected' }>['properties'],
): void {
  telemetry.emit({
    name: 'unified.lifecycle.gap_detected',
    properties,
  });
}

export function emitClaudeUnifiedHostDead(
  telemetry: ClaudeUnifiedTelemetrySink,
  params: Readonly<{
    hostKind: TerminalHostKind;
    sessionName: string;
    paneId?: string | undefined;
    liveness?: TerminalHostLiveness | undefined;
  }>,
): void {
  telemetry.emit({
    name: 'unified.session.host_dead',
    properties: {
      hostKind: params.hostKind,
      sessionName: params.sessionName,
      ...(params.paneId ? { paneId: params.paneId } : {}),
      paneAlive: params.liveness?.paneAlive ?? false,
      ...(params.liveness?.paneDead !== undefined ? { paneDead: params.liveness.paneDead } : {}),
      ...(params.liveness?.panePid !== undefined ? { panePid: params.liveness.panePid } : {}),
      ...(params.liveness?.paneCurrentCommand ? { paneCurrentCommand: params.liveness.paneCurrentCommand } : {}),
      ...(params.liveness?.paneExitStatus !== undefined ? { paneExitStatus: params.liveness.paneExitStatus } : {}),
      ...(params.liveness?.paneScreenDumpCaptured ? { paneScreenDumpCaptured: true } : {}),
      ...(params.liveness?.paneScreenDumpTruncated !== undefined ? { paneScreenDumpTruncated: params.liveness.paneScreenDumpTruncated } : {}),
      ...(params.liveness?.paneScreenDumpError ? { paneScreenDumpErrorCaptured: true } : {}),
      observedAt: params.liveness?.observedAt ?? Date.now(),
    },
  });
}

export function emitClaudeUnifiedDialogTurnEndIdleStarvation(
  telemetry: ClaudeUnifiedTelemetrySink,
  properties: Extract<ClaudeUnifiedTelemetryEvent, { name: 'unified.dialog.turn_end_idle_starvation' }>['properties'],
): void {
  telemetry.emit({
    name: 'unified.dialog.turn_end_idle_starvation',
    properties: {
      shots: Math.max(0, Math.trunc(properties.shots)),
      windowMs: Math.max(0, Math.trunc(properties.windowMs)),
    },
  });
}

export function emitClaudeUnifiedDialogTurnStallStarvation(
  telemetry: ClaudeUnifiedTelemetrySink,
  properties: Extract<ClaudeUnifiedTelemetryEvent, { name: 'unified.dialog.turn_stall_starvation' }>['properties'],
): void {
  telemetry.emit({
    name: 'unified.dialog.turn_stall_starvation',
    properties: {
      attempts: Math.max(0, Math.trunc(properties.attempts)),
      windowMs: Math.max(0, Math.trunc(properties.windowMs)),
    },
  });
}

export function emitClaudeUnifiedWindowsGuardTriggered(
  telemetry: ClaudeUnifiedTelemetrySink,
  guard: Extract<ClaudeUnifiedTelemetryEvent, { name: 'unified.session.windows_guard_triggered' }>['properties']['guard'],
): void {
  telemetry.emit({
    name: 'unified.session.windows_guard_triggered',
    properties: {
      guard,
      hostKind: 'zellij',
      platform: 'win32',
    },
  });
}

export function maybeEmitClaudeUnifiedWindowsGuardTriggered(
  telemetry: ClaudeUnifiedTelemetrySink,
  reason: string,
): void {
  if (
    reason === 'windows_arm64_unsupported'
    || reason === 'windows_zellij_unvalidated'
  ) {
    emitClaudeUnifiedWindowsGuardTriggered(telemetry, reason);
  }
}
