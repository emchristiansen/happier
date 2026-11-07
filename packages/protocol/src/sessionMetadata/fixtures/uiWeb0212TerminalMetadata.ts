// Historical terminal schema from ui-web-v0.2.12 (a357c65536ba89669422977d6f7daf9aa0d17e73).
// Its windowsRemoteSessionLaunchMode constant is inlined verbatim from that same tag.
// Test-only released reader: do not update it when the current schema evolves.
import { z } from 'zod';
const WINDOWS_REMOTE_SESSION_LAUNCH_MODES = ['hidden', 'windows_terminal', 'console'] as const;

/**
 * Session terminal attachment metadata (stored in encrypted `session.metadata`).
 *
 * Keep schemas permissive (passthrough) for forward compatibility.
 * Use factory forms for nohoist/multi-Zod repos.
 */

export function createSessionTerminalMetadataSchema(zod: typeof z) {
  const terminalModeSchema = zod.enum(['plain', 'tmux', 'zellij', 'windows_terminal', 'windows_console']);
  const requestedModeSchema = zod.enum(['plain', 'tmux', 'zellij', ...WINDOWS_REMOTE_SESSION_LAUNCH_MODES]);
  return zod
    .object({
      // Optional only for compatibility with retirement tombstones written by the
      // first attachment-bound serviceability writer before it preserved host mode.
      mode: terminalModeSchema.optional(),
      requested: requestedModeSchema.optional(),
      fallbackReason: zod.string().optional(),
      controlServiceabilityV1: zod.object({
        v: zod.literal(1),
        attachmentId: zod.string().optional(),
        state: zod.enum(['servable', 'recoverable_unservable', 'unknown']),
        observedAt: zod.number(),
        reason: zod.string().optional(),
        retired: zod.boolean().optional(),
      }).passthrough().optional(),
      tmux: zod
        .object({
          target: zod.string(),
          tmpDir: zod.string().nullable().optional(),
        })
        .optional(),
      zellij: zod
        .object({
          sessionName: zod.string(),
          paneId: zod.string().optional(),
          /** Socket-root attestation for hosts written by the v1 terminal-host metadata writer. */
          socketDirV1: zod.string().optional(),
        })
        .optional(),
      windows: zod
        .object({
          host: zod.enum(['windows_terminal', 'console']),
          windowId: zod.string().optional(),
          pid: zod.number().int().optional(),
          title: zod.string().optional(),
        })
        .optional(),
    })
    .passthrough()
    .superRefine((terminal, ctx) => {
      if (terminal.mode !== undefined) return;
      if (terminal.controlServiceabilityV1?.retired === true) return;
      ctx.addIssue({
        code: 'custom',
        path: ['mode'],
        message: 'Terminal mode is required outside legacy retirement tombstones',
      });
    });
}

export const SessionTerminalMetadataSchema = createSessionTerminalMetadataSchema(z);
