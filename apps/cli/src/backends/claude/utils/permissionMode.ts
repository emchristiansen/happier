import { claudeCliFlagCanConsumeNextArg } from '../cli/flagArity';
import type { QueryOptions } from '@/backends/claude/sdk';
import type { PermissionMode } from '@/api/types';

/** Derived from SDK's QueryOptions - the modes Claude actually supports */
export type ClaudeSdkPermissionMode = NonNullable<QueryOptions['permissionMode']>;

/** Keep live bypass switching available without making ordinary root launches fail. */
export function shouldAllowClaudePermissionBypass(env: Readonly<NodeJS.ProcessEnv>): boolean {
    // Claude Code also checks the capability flag at startup, even in default/auto mode.
    // Only honor sandbox assertions already present in the effective child environment.
    return process.platform === 'win32'
        || process.getuid?.() !== 0
        || env.IS_SANDBOX === '1'
        || env.CLAUDE_CODE_BUBBLEWRAP === '1';
}

/**
 * Normalize the session-control flag we pass through Happier CLI when spawning Claude.
 *
 * This boundary is earlier than the actual Claude SDK/CLI launch boundary: the value still has to
 * round-trip through Happier's own CLI parser and metadata model first. That means we can only
 * rewrite tokens that Happier already accepts and canonicalizes back to the same intent.
 *
 * In practice:
 * - yolo → bypassPermissions
 * - safe-yolo must remain safe-yolo here so Unified can map it to Claude auto at launch
 * - read-only must remain read-only here (do not rewrite to dontAsk at this boundary)
 */
export function normalizeClaudeHappyCliSessionControlPermissionMode(mode: string): string {
    if (mode === 'yolo') return 'bypassPermissions';
    return mode;
}

/**
 * Map any PermissionMode (7 modes) to a Claude-compatible mode (6 modes)
 * This is the ONLY place where Codex modes are mapped to Claude equivalents.
 *
 * Mapping:
 * - yolo → bypassPermissions (both skip all permissions)
 * - safe-yolo → auto (Claude's conservative auto-approve mode)
 * - read-only → dontAsk
 *
 * Claude modes pass through unchanged:
 * - default, acceptEdits, bypassPermissions, plan, dontAsk, auto
 */
export function mapToClaudeMode(mode: PermissionMode): ClaudeSdkPermissionMode {
    const codexToClaudeMap: Record<string, ClaudeSdkPermissionMode> = {
        'yolo': 'bypassPermissions',
        'safe-yolo': 'auto',
        'read-only': 'dontAsk',
    };
    return codexToClaudeMap[mode] ?? (mode as ClaudeSdkPermissionMode);
}

export function resolveClaudeSdkPermissionModeFromEnhancedMode(mode: {
    permissionMode: PermissionMode;
    agentModeId?: string | null | undefined;
}): ClaudeSdkPermissionMode {
    const agentModeId = typeof mode.agentModeId === 'string' ? mode.agentModeId.trim() : '';
    if (agentModeId === 'plan') return 'plan';
    return mapToClaudeMode(mode.permissionMode);
}

/** Extract only permission options, preserving option values and positional payload verbatim. */
export function extractClaudePermissionModeArgs(input: readonly string[]): {
    args: string[];
    permissionMode: string | undefined;
} {
    const args: string[] = [];
    let permissionMode: string | undefined;
    for (let index = 0; index < input.length; index++) {
        const arg = input[index]!;
        if (arg === '--') {
            args.push(...input.slice(index));
            break;
        }
        if (arg === '--dangerously-skip-permissions') {
            permissionMode = 'bypassPermissions';
            continue;
        }
        const next = input[index + 1];
        if (arg === '--permission-mode' && next && !next.startsWith('-')) {
            permissionMode = next;
            index++;
            continue;
        }
        if (arg.startsWith('--permission-mode=') && arg.length > '--permission-mode='.length) {
            permissionMode = arg.slice('--permission-mode='.length);
            continue;
        }
        args.push(arg);
        if (claudeCliFlagCanConsumeNextArg(arg, next)) {
            args.push(next!);
            index++;
        }
    }
    return { args, permissionMode };
}

/** Emit the literal bypass switch only when bypass is the final selected mode. */
export function buildClaudePermissionModeArgs(permissionMode: string | undefined): string[] {
    if (permissionMode === undefined) return [];
    return permissionMode === 'bypassPermissions'
        ? ['--dangerously-skip-permissions']
        : ['--permission-mode', permissionMode];
}
