import { randomUUID } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const WINDOWS_EXTENDED_LENGTH_PREFIX = '\\\\?\\';
const WINDOWS_UNC_PREFIX = '\\\\';
const WINDOWS_EXTENDED_LENGTH_UNC_PREFIX = '\\\\?\\UNC\\';
const WINDOWS_DEVICE_PREFIX = '\\\\.\\';
const WINDOWS_DRIVE_ABSOLUTE_PATH_PATTERN = /^[a-zA-Z]:\\/;
const BACKUP_CLEANUP_MAX_ATTEMPTS = 6;
const BACKUP_CLEANUP_RETRY_DELAY_MS = 25;

export function toWindowsExtendedLengthPathForFs(
    pathLike: string,
    platform: NodeJS.Platform = process.platform,
): string {
    if (platform !== 'win32') {
        return pathLike;
    }

    const normalizedPath = pathLike.replaceAll('/', '\\');

    if (
        normalizedPath.startsWith(WINDOWS_EXTENDED_LENGTH_PREFIX)
        || normalizedPath.startsWith(WINDOWS_DEVICE_PREFIX)
    ) {
        return normalizedPath;
    }

    if (normalizedPath.startsWith(WINDOWS_UNC_PREFIX)) {
        return `${WINDOWS_EXTENDED_LENGTH_UNC_PREFIX}${normalizedPath.slice(WINDOWS_UNC_PREFIX.length)}`;
    }

    if (WINDOWS_DRIVE_ABSOLUTE_PATH_PATTERN.test(normalizedPath)) {
        return `${WINDOWS_EXTENDED_LENGTH_PREFIX}${normalizedPath}`;
    }

    return pathLike;
}

function toRuntimeFsPath(pathLike: string): string {
    return toWindowsExtendedLengthPathForFs(pathLike);
}

function shouldSkipPayloadPath(pathLike: string): boolean {
    const segments = pathLike.split(/[\\/]/).filter(Boolean);
    for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        if (segment.startsWith('._')) {
            return true;
        }
        if (segment === '.bin' && segments[index - 1] === 'node_modules') {
            return true;
        }
    }
    return false;
}

async function copyDirectoryContentsRecursively(sourceDir: string, destinationDir: string): Promise<void> {
    await mkdir(toRuntimeFsPath(destinationDir), { recursive: true });
    const entries = await readdir(toRuntimeFsPath(sourceDir), { withFileTypes: true });

    for (const entry of entries) {
        if (shouldSkipPayloadPath(entry.name)) {
            continue;
        }

        const sourcePath = join(sourceDir, entry.name);
        const destinationPath = join(destinationDir, entry.name);

        if (shouldSkipPayloadPath(sourcePath)) {
            continue;
        }

        if (entry.isDirectory()) {
            await copyDirectoryContentsRecursively(sourcePath, destinationPath);
            continue;
        }

        await mkdir(toRuntimeFsPath(dirname(destinationPath)), { recursive: true });
        await copyFile(toRuntimeFsPath(sourcePath), toRuntimeFsPath(destinationPath));
    }
}

function readErrorCode(error: unknown): string | null {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
        return null;
    }
    return typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : null;
}

function isRetryableRenameError(error: unknown): boolean {
    const code = readErrorCode(error);
    return code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function removeRuntimePayloadPath(path: string): Promise<void> {
    for (let attempt = 1; attempt <= BACKUP_CLEANUP_MAX_ATTEMPTS; attempt += 1) {
        try {
            await rm(toRuntimeFsPath(path), { recursive: true, force: true });
            return;
        } catch (error) {
            if (!isRetryableRenameError(error) || attempt === BACKUP_CLEANUP_MAX_ATTEMPTS) {
                throw error;
            }
            await sleep(BACKUP_CLEANUP_RETRY_DELAY_MS);
        }
    }
}

async function cleanupBackupPathBestEffort(backupPath: string): Promise<void> {
    await removeRuntimePayloadPath(backupPath).catch(() => undefined);
}

async function pruneSkippedPayloadPathsRecursively(rootDir: string, currentDir: string = rootDir): Promise<void> {
    const entries = await readdir(toRuntimeFsPath(currentDir), { withFileTypes: true });

    for (const entry of entries) {
        const entryPath = join(currentDir, entry.name);
        const relativePath = entryPath.slice(rootDir.length).replace(/^[/\\]+/, '');

        if (shouldSkipPayloadPath(relativePath)) {
            await rm(toRuntimeFsPath(entryPath), { recursive: true, force: true });
            continue;
        }

        if (entry.isDirectory()) {
            await pruneSkippedPayloadPathsRecursively(rootDir, entryPath);
        }
    }
}

async function promoteStagedRuntimePayload(params: Readonly<{
    tempPath: string;
    destinationPath: string;
}>): Promise<void> {
    if (process.platform !== 'win32') {
        await rename(toRuntimeFsPath(params.tempPath), toRuntimeFsPath(params.destinationPath));
        return;
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
            await rename(toRuntimeFsPath(params.tempPath), toRuntimeFsPath(params.destinationPath));
            return;
        } catch (error) {
            if (!isRetryableRenameError(error)) {
                throw error;
            }
            if (attempt < 3) {
                await sleep(25 * (attempt + 1));
                continue;
            }
        }
    }

    await rm(toRuntimeFsPath(params.destinationPath), { recursive: true, force: true }).catch(() => undefined);
    try {
        await copyDirectoryContentsRecursively(params.tempPath, params.destinationPath);
        await rm(toRuntimeFsPath(params.tempPath), { recursive: true, force: true });
    } catch (error) {
        await rm(toRuntimeFsPath(params.destinationPath), { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}

export async function replaceRuntimePayloadTree(params: Readonly<{
    sourcePath: string;
    destinationPath: string;
    consumeSourcePath?: boolean;
    sourcePathAlreadyFiltered?: boolean;
}>): Promise<void> {
    const destinationPath = params.destinationPath;
    const destinationParent = dirname(destinationPath);
    const destinationBasename = basename(destinationPath);
    const tempPath = join(destinationParent, `.${destinationBasename}.tmp-${process.pid}-${randomUUID()}`);
    const backupPath = join(destinationParent, `.${destinationBasename}.bak-${process.pid}-${randomUUID()}`);
    const destinationExists = await lstat(toRuntimeFsPath(destinationPath))
        .then(() => true)
        .catch(() => false);
    const shouldConsumeSourcePath = params.consumeSourcePath === true;
    let movedSourceIntoTemp = false;

    await rm(toRuntimeFsPath(tempPath), { recursive: true, force: true });
    await rm(toRuntimeFsPath(backupPath), { recursive: true, force: true });

    try {
        await mkdir(toRuntimeFsPath(destinationParent), { recursive: true });

        if (shouldConsumeSourcePath) {
            try {
                await rename(toRuntimeFsPath(params.sourcePath), toRuntimeFsPath(tempPath));
                movedSourceIntoTemp = true;
            } catch (error) {
                const code = readErrorCode(error);
                if (code !== 'EXDEV' && !isRetryableRenameError(error)) {
                    throw error;
                }
            }
        }

        if (!movedSourceIntoTemp && process.platform === 'win32') {
            await copyDirectoryContentsRecursively(params.sourcePath, tempPath);
        } else if (!movedSourceIntoTemp) {
            await cp(toRuntimeFsPath(params.sourcePath), toRuntimeFsPath(tempPath), {
                recursive: true,
                filter: (sourcePath) => !shouldSkipPayloadPath(sourcePath),
            });
        } else if (!params.sourcePathAlreadyFiltered) {
            await pruneSkippedPayloadPathsRecursively(tempPath);
        }

        if (destinationExists) {
            await rename(toRuntimeFsPath(destinationPath), toRuntimeFsPath(backupPath));
        }

        await promoteStagedRuntimePayload({
            tempPath,
            destinationPath,
        });

        if (destinationExists) {
            await cleanupBackupPathBestEffort(backupPath);
        }
    } catch (error) {
        if (movedSourceIntoTemp) {
            const sourceExists = await lstat(toRuntimeFsPath(params.sourcePath))
                .then(() => true)
                .catch(() => false);
            if (!sourceExists) {
                await rename(toRuntimeFsPath(tempPath), toRuntimeFsPath(params.sourcePath)).catch(() => undefined);
            }
        } else {
            await rm(toRuntimeFsPath(tempPath), { recursive: true, force: true }).catch(() => undefined);
        }

        const backupExists = await lstat(toRuntimeFsPath(backupPath))
            .then(() => true)
            .catch(() => false);
        if (backupExists) {
            const destinationStillExists = await lstat(toRuntimeFsPath(destinationPath))
                .then(() => true)
                .catch(() => false);
            if (!destinationStillExists) {
                await rename(toRuntimeFsPath(backupPath), toRuntimeFsPath(destinationPath)).catch(() => undefined);
            }
        }

        throw error;
    }
}
