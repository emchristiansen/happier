import { z } from 'zod';

import {
    isCatalogClaudeModelId,
    isClaudeModelEffortPinned,
    requireClaudeModelEffortOverrides,
    resolveClaudeEffortForModel,
} from './claudeEffort';
import type { ClaudeEffortLevel } from './claudeEffortLevel';

/**
 * Native Claude Code session-settings controls (stream-json control requests `get_settings` and
 * `apply_flag_settings`). Either is absent when the transport does not offer it.
 */
export type ClaudeNativeSettingsControl = Readonly<{
    getSettings: (() => Promise<unknown>) | undefined;
    applyFlagSettings: ((settings: Record<string, unknown>) => Promise<void>) | undefined;
}>;

export type ClaudeModelEffortPinBridgeResult =
    | Readonly<{ kind: 'no-pin-configured' }>
    | Readonly<{ kind: 'not-pinned'; model: string }>
    | Readonly<{ kind: 'applied'; model: string; effort: ClaudeEffortLevel }>;

// `get_settings` reports the session's resolved model (aliases and the native default included)
// under `applied`. Only the fields this bridge reads are parsed.
const AppliedSettingsSchema = z.object({
    applied: z.object({
        model: z.string().min(1),
        effort: z.string().nullish(),
        ultracode: z.boolean().nullish(),
    }),
});

type AppliedSettings = z.infer<typeof AppliedSettingsSchema>['applied'];

async function readAppliedSettings(getSettings: () => Promise<unknown>): Promise<AppliedSettings> {
    const parsed = AppliedSettingsSchema.safeParse(await getSettings());
    if (!parsed.success) {
        throw new Error('Claude Code get_settings returned no applied model; the pinned effort cannot be verified');
    }
    return parsed.data.applied;
}

function adopts(applied: AppliedSettings, effort: ClaudeEffortLevel): boolean {
    return applied.effort === effort && applied.ultracode !== true;
}

/**
 * Make a live Claude Code session honor the per-model effort pin before a prompt is sent.
 *
 * Launch flags cannot pin a model Claude Code resolves itself (no `--model`, or an alias), so this
 * reads the session's applied model and, when it is pinned, applies the pinned effort with
 * ultracode off. Claude Code acknowledges an `apply_flag_settings` it then ignores, so adoption is
 * proven only by reading the applied settings back. Throws when the pin cannot be verified or
 * adopted; the caller must not send the prompt. Does nothing when no pin is configured.
 */
export async function enforceClaudeModelEffortPinBeforePrompt(
    control: ClaudeNativeSettingsControl,
): Promise<ClaudeModelEffortPinBridgeResult> {
    if (requireClaudeModelEffortOverrides().size === 0) return { kind: 'no-pin-configured' };
    const { getSettings, applyFlagSettings } = control;
    if (!getSettings || !applyFlagSettings) {
        throw new Error('This Claude Code transport cannot read or apply session settings; the pinned effort cannot be verified');
    }

    const before = await readAppliedSettings(getSettings);
    if (!isClaudeModelEffortPinned(before.model)) return { kind: 'not-pinned', model: before.model };
    const effort = resolveClaudeEffortForModel({ modelId: before.model, effort: undefined });
    if (!effort) {
        throw new Error(`Claude model ${before.model} does not support its pinned effort`);
    }
    if (adopts(before, effort)) return { kind: 'applied', model: before.model, effort };

    await applyFlagSettings({ effortLevel: effort, ultracode: false });
    const after = await readAppliedSettings(getSettings);
    if (after.model !== before.model || !adopts(after, effort)) {
        throw new Error(
            `Claude Code did not adopt the pinned effort ${effort} for ${before.model} `
            + `(applied effort: ${after.effort ?? 'none'}, model: ${after.model})`,
        );
    }
    return { kind: 'applied', model: after.model, effort };
}

export type ClaudeTerminalLaunchPinResult =
    | Readonly<{ kind: 'unchanged' }>
    | Readonly<{ kind: 'pinned'; model: string; effort: ClaudeEffortLevel }>;

/**
 * Qualify a terminal launch's model against the effort pin before the terminal starts.
 *
 * A terminal (local or unified) offers no control channel before its first prompt, so a model
 * Claude Code resolves itself (no `--model`, or an alias) is resolved first by asking the same
 * Claude Code for its applied settings. A pinned result is returned as the exact model to launch
 * (so the terminal runs the model that was qualified) with its pinned effort. A launch that
 * already names a pinned or concrete catalog model, or any launch when no pin is configured,
 * needs no enquiry.
 * Throws when the model cannot be qualified; the caller must not start the terminal.
 */
export async function qualifyClaudeTerminalLaunchModelEffortPin(params: Readonly<{
    explicitModel: string | undefined;
    modelResolutionArgs: readonly string[];
    readSettings: (modelResolutionArgs: readonly string[]) => Promise<unknown>;
}>): Promise<ClaudeTerminalLaunchPinResult> {
    if (requireClaudeModelEffortOverrides().size === 0) return { kind: 'unchanged' };
    // An explicit pinned or concrete catalog model is launched as named: nothing to resolve.
    if (isClaudeModelEffortPinned(params.explicitModel) || isCatalogClaudeModelId(params.explicitModel)) {
        return { kind: 'unchanged' };
    }

    let applied: AppliedSettings;
    try {
        applied = await readAppliedSettings(() => params.readSettings(params.modelResolutionArgs));
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot start Claude: its model could not be checked against the pinned effort (${reason})`);
    }
    if (!isClaudeModelEffortPinned(applied.model)) return { kind: 'unchanged' };
    const effort = resolveClaudeEffortForModel({ modelId: applied.model, effort: undefined });
    if (!effort) throw new Error(`Claude model ${applied.model} does not support its pinned effort`);
    return { kind: 'pinned', model: applied.model, effort };
}
