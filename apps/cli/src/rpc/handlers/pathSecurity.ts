import { lstatSync, realpathSync } from 'fs';
import { basename, dirname, isAbsolute, relative, resolve, sep, join } from 'path';

export interface PathValidationResult {
    valid: boolean;
    error?: string;
    resolvedPath?: string;
}


// This is a durable restriction on newly created dedicated private domains.
// Its absence grants no authority, and this utility never creates a marker.
export const PRIVATE_NATIVE_DOMAIN_MARKER = '.muninn-private-native-domain';

function isMissingPath(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR';
}

function hasPrivateNativeDomainAncestor(targetPath: string): boolean {
    for (let candidate = targetPath;; candidate = dirname(candidate)) {
        try {
            lstatSync(join(candidate, PRIVATE_NATIVE_DOMAIN_MARKER));
            return true;
        } catch (error) {
            if (!isMissingPath(error)) throw error;
        }
        if (dirname(candidate) === candidate) return false;
    }
}

function resolveReaderPathThroughExistingAncestor(targetPath: string): string {
    let candidate = targetPath;
    const missing: string[] = [];
    for (;;) {
        try {
            // The JS realpath resolver normalizes '..' before following symlinks.
            // Native resolution preserves the identity used by read/open, including
            // when only an existing ancestor of a future write target is present.
            return resolve(realpathSync.native(candidate), ...missing);
        } catch (error) {
            if (!isMissingPath(error)) throw error;
            // Do not discard a symlink whose target cannot be resolved. Its
            // missing destination may belong to a different restricted domain.
            let unresolvedSymlink = false;
            try {
                unresolvedSymlink = lstatSync(candidate).isSymbolicLink();
            } catch (inspectionError) {
                if (!isMissingPath(inspectionError)) throw inspectionError;
            }
            if (unresolvedSymlink) throw error;
            const parent = dirname(candidate);
            if (parent === candidate) throw error;
            missing.unshift(basename(candidate));
            candidate = parent;
        }
    }
}

/** Ordinary readers may not open a dedicated private native domain.
 * This negative restriction is independent of workspace or os-user authority.
 * Check lexical ancestors and both native path identities: consumers may open
 * the original string or its lexical normalization. Unresolved symlinks refuse;
 * plain missing descendants are inspected through their existing ancestor.
 */
export function validateOrdinaryReaderPath(targetPath: string): PathValidationResult {
    try {
        const lexical = resolve(targetPath);
        if (hasPrivateNativeDomainAncestor(lexical)
            || hasPrivateNativeDomainAncestor(resolveReaderPathThroughExistingAncestor(targetPath))
            || hasPrivateNativeDomainAncestor(resolveReaderPathThroughExistingAncestor(lexical))) {
            return { valid: false, error: 'Access denied: private native domain' };
        }
        return { valid: true, resolvedPath: lexical };
    } catch {
        return { valid: false, error: 'Access denied: unable to inspect private native domain restriction; values not shown' };
    }
}

export function assertOrdinaryReaderPath(targetPath: string): void {
    const result = validateOrdinaryReaderPath(targetPath);
    if (!result.valid) throw new Error(result.error);
}

function resolveRealPathThroughExistingAncestor(targetPath: string): string {
    let candidate = targetPath;
    const missingSegments: string[] = [];

    for (;;) {
        try {
            return resolve(realpathSync(candidate), ...missingSegments);
        } catch {
            const parent = dirname(candidate);
            if (parent === candidate) return targetPath;
            missingSegments.unshift(basename(candidate));
            candidate = parent;
        }
    }
}

export function validateWorkspaceInspectionPath(targetPath: string): PathValidationResult {
    const trimmedPath = typeof targetPath === 'string' ? targetPath.trim() : '';
    if (!trimmedPath) {
        return {
            valid: false,
            error: 'candidatePath is required',
        };
    }
    if (trimmedPath.includes('\0')) {
        return {
            valid: false,
            error: 'Attached workspace candidate path contains invalid characters',
        };
    }
    if (!isAbsolute(trimmedPath)) {
        return {
            valid: false,
            error: 'Attached workspace candidate path must be absolute',
        };
    }

    return validateOrdinaryReaderPath(trimmedPath);
}

/**
 * Validates that a path is within the allowed working directory
 * @param targetPath - The path to validate (can be relative or absolute)
 * @param workingDirectory - The session's working directory (must be absolute)
 * @param additionalAllowedDirs - Extra absolute directories that are also permitted
 * @returns Validation result
 */
export function validatePath(
    targetPath: string,
    workingDirectory: string,
    additionalAllowedDirs?: ReadonlyArray<string>,
): PathValidationResult {
    if (!workingDirectory || typeof workingDirectory !== 'string') {
        return { valid: false, error: 'Access denied: Invalid working directory' };
    }

    // Resolve and realpath the working directory to ensure comparisons stay consistent on platforms
    // where e.g. /var is a symlink to /private/var (macOS).
    const resolvedWorkingDir = resolve(workingDirectory);
    const realWorkingDir = resolveRealPathThroughExistingAncestor(resolvedWorkingDir);

    // Resolve the target against the real working dir to keep it on the same canonical root.
    const resolvedTarget = resolve(realWorkingDir, targetPath);

    const resolvedExtraDirs = (additionalAllowedDirs ?? [])
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => resolve(value));

    // Resolve symlinks for the target when possible to prevent traversal via symlinks.
    // If the file doesn't exist yet, validate based on the realpath of its parent directory.
    const restriction = validateOrdinaryReaderPath(resolvedTarget);
    if (!restriction.valid) return restriction;
    const realTarget = resolveRealPathThroughExistingAncestor(resolvedTarget);

    const allowedDirs = [realWorkingDir, ...resolvedExtraDirs].map((dir) => {
        try {
            return realpathSync(dir);
        } catch {
            // Directory may not exist yet (e.g., upload dir before first upload).
            return dir;
        }
    });

    for (const dir of allowedDirs) {
        const rel = relative(dir, realTarget);
        if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
            return { valid: true, resolvedPath: resolvedTarget };
        }
    }

    return {
        valid: false,
        error: `Access denied: Path '${targetPath}' is outside the allowed directories`,
    };
}
