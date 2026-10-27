import { join, posix } from 'node:path';

import {
    buildHappyCliSubprocessLaunchSpec,
    type HappyCliSubprocessLaunchOptions,
    type HappyCliSubprocessLaunchSpec,
} from '@/utils/spawnHappyCLI';
import { resolveDaemonSessionScopeBaseRelativePath } from './resolveDaemonSessionScopeBaseRelativePath';
import {
    buildSessionLaunchPlacementIntent,
    type SessionLaunchPlacementIntent,
} from './observeSessionLaunchPlacement';
import type { SessionLaunchId } from './sessionLaunchId';
import {
    buildSystemdUserScopedLaunchSpec,
    probeSystemdUserResourceGovernor,
    type SystemdUserResourceGovernorExecFile,
} from './systemdUserResourceGovernor';

function normalizePid(raw: unknown): number | null {
    return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null;
}

async function readUnifiedProcessCgroupRelativePath(
    pid: number,
    procfsRootDir: string,
): Promise<string | null> {
    try {
        const { readFile } = await import('node:fs/promises');
        const raw = await readFile(join(procfsRootDir, String(pid), 'cgroup'), 'utf8');
        for (const line of raw.split('\n')) {
            if (!line.startsWith('0::')) continue;
            const relativePath = line.slice('0::'.length).trim();
            return relativePath || null;
        }
        return null;
    } catch {
        return null;
    }
}

export type ExecutableLaunchSpec = Readonly<{
    filePath: string;
    args: string[];
    env?: Record<string, string>;
}>;

/**
 * The launch for one attempt plus what it asked for. `launchSpec` is null when the
 * caller should use its plain launch; `placement` is the intent the attempt's
 * `launch-placement` line starts from.
 */
export type SessionLaunchPlan = Readonly<{
    launchSpec: ExecutableLaunchSpec | null;
    placement: SessionLaunchPlacementIntent;
}>;

export async function buildCgroupSelfMigratingHappyCliLaunchSpec(params: Readonly<{
    launchId: SessionLaunchId;
    daemonPid?: number;
    procfsRootDir?: string;
    cgroupRootDir?: string;
    environment?: NodeJS.ProcessEnv;
    systemdUserResourceGovernorExecFile?: SystemdUserResourceGovernorExecFile;
} & (
    | { args: string[]; launchOptions?: HappyCliSubprocessLaunchOptions; launchSpec?: never }
    | { launchSpec: HappyCliSubprocessLaunchSpec; args?: never; launchOptions?: never }
)>): Promise<SessionLaunchPlan> {
    const daemonPid = normalizePid(params.daemonPid) ?? process.pid;
    const procfsRootDir = params.procfsRootDir ?? '/proc';
    const cgroupRootDir = params.cgroupRootDir ?? '/sys/fs/cgroup';
    const baseLaunchSpec = params.launchSpec ?? buildHappyCliSubprocessLaunchSpec(params.args, params.launchOptions);
    const probe = await probeSystemdUserResourceGovernor({
        environment: params.environment ?? process.env,
        execFile: params.systemdUserResourceGovernorExecFile,
    });
    if (probe.kind === 'ready') {
        const launchSpec = buildSystemdUserScopedLaunchSpec({
            launchId: params.launchId,
            launchSpec: {
                filePath: baseLaunchSpec.filePath,
                args: baseLaunchSpec.args,
                env: {
                    ...(baseLaunchSpec.env ?? {}),
                    // A systemd scope is the owner of this process tree. Do not let the
                    // legacy runner-side cgroup migration move the child out of it.
                    HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP: '',
                },
            },
        });
        return { launchSpec, placement: buildSessionLaunchPlacementIntent(params.launchId) };
    }

    // Best-effort coverage: a failed probe launches exactly as before, unscoped, and the
    // attempt's placement line carries the probe's reason.
    const unscoped: SessionLaunchPlacementIntent = { kind: 'unscoped', probe };

    const daemonServiceRelativePath = await readUnifiedProcessCgroupRelativePath(daemonPid, procfsRootDir);
    if (!daemonServiceRelativePath) {
        return { launchSpec: null, placement: unscoped };
    }

    const sessionScopeBaseRelativePath = resolveDaemonSessionScopeBaseRelativePath(daemonServiceRelativePath);
    if (!sessionScopeBaseRelativePath || sessionScopeBaseRelativePath === '.' || sessionScopeBaseRelativePath === daemonServiceRelativePath) {
        return { launchSpec: null, placement: unscoped };
    }

    const appSliceAbsolutePath = join(cgroupRootDir, sessionScopeBaseRelativePath);

    const legacyLaunchSpec: ExecutableLaunchSpec = {
        filePath: '/bin/sh',
        args: [
            '-lc',
            'target_dir="$HAPPIER_DAEMON_SESSION_CGROUP_BASE_DIR/happier-session-$$.scope"; mkdir -p "$target_dir" 2>/dev/null || true; printf "%s\\n" "$$" > "$target_dir/cgroup.procs" 2>/dev/null || true; exec "$@"',
            'sh',
            baseLaunchSpec.filePath,
            ...baseLaunchSpec.args,
        ],
        env: {
            ...(baseLaunchSpec.env ?? {}),
            HAPPIER_DAEMON_SESSION_CGROUP_BASE_DIR: appSliceAbsolutePath,
        },
    };
    return { launchSpec: legacyLaunchSpec, placement: unscoped };
}
