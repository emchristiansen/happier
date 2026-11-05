import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { claudeCliFlagCanConsumeNextArg } from '../cli/flagArity';
import {
    materializeProtectedTempTextArtifact,
    type ProtectedTempTextArtifact,
} from '@/utils/fs/protectedTempTextArtifact';

export type MaterializedClaudeSystemPromptArgs = Readonly<{
    args: string[];
    cleanupPaths: string[];
    cleanup: () => Promise<void>;
    /** For the process that owns the child to use during synchronous shutdown. */
    cleanupSync: () => void;
}>;

/** Keep append-prompt contents out of argv without changing their bytes or option order. */
export async function materializeClaudeSystemPromptArgsForSpawn(
    inputArgs: readonly string[],
): Promise<MaterializedClaudeSystemPromptArgs> {
    const args = [...inputArgs];
    const artifacts: ProtectedTempTextArtifact[] = [];
    const cleanup = async (): Promise<void> => {
        await Promise.all(artifacts.map((artifact) => artifact.cleanup()));
    };
    const cleanupSync = (): void => {
        for (const artifact of artifacts) {
            try {
                rmSync(dirname(artifact.path), { recursive: true, force: true });
            } catch {
                // Best-effort cleanup during synchronous process shutdown.
            }
        }
    };
    const materialize = async (contents: string): Promise<string> => {
        const artifact = await materializeProtectedTempTextArtifact({
            prefix: 'happier-claude-system-prompt-',
            contents,
        });
        artifacts.push(artifact);
        return artifact.path;
    };
    try {
        for (let index = 0; index < args.length; index++) {
            const arg = args[index]!;
            if (arg === '--') break;
            if (arg === '--append-system-prompt' && typeof args[index + 1] === 'string') {
                args[index] = '--append-system-prompt-file';
                args[index + 1] = await materialize(args[index + 1]!);
                index++;
            } else if (arg.startsWith('--append-system-prompt=')) {
                args[index] = `--append-system-prompt-file=${await materialize(arg.slice('--append-system-prompt='.length))}`;
            } else if (claudeCliFlagCanConsumeNextArg(arg, args[index + 1])) {
                index++;
            }
        }
        return { args, cleanupPaths: artifacts.map((artifact) => artifact.path), cleanup, cleanupSync };
    } catch (error) {
        await cleanup();
        throw error;
    }
}
