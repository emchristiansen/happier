import { resolve } from 'path';
import { afterAll, describe, it, expect } from 'vitest';
import { validateOrdinaryReaderPath, validatePath, validateWorkspaceInspectionPath } from './pathSecurity';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('validatePath', () => {
    const workingRoot = mkdtempSync(join(tmpdir(), 'happier-pathSecurity-working-'));
    const workingDir = join(workingRoot, 'project');
    mkdirSync(workingDir, { recursive: true });
    const canonicalWorkingDir = realpathSync(workingDir);

    afterAll(() => {
        rmSync(workingRoot, { recursive: true, force: true });
    });

    it('should allow paths within working directory', () => {
        expect(validatePath(resolve(workingDir, 'file.txt'), workingDir)).toMatchObject({
            valid: true,
            resolvedPath: resolve(workingDir, 'file.txt'),
        });
        expect(validatePath('file.txt', workingDir)).toMatchObject({
            valid: true,
            resolvedPath: resolve(canonicalWorkingDir, 'file.txt'),
        });
        expect(validatePath('./src/file.txt', workingDir)).toMatchObject({
            valid: true,
            resolvedPath: resolve(canonicalWorkingDir, 'src', 'file.txt'),
        });
    });

    it('should reject paths outside working directory', () => {
        const result = validatePath('/etc/passwd', workingDir);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('outside the allowed directories');
    });

    it('should prevent path traversal attacks', () => {
        const result = validatePath('../../.ssh/id_rsa', workingDir);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('outside the allowed directories');
    });

    it('normalizes dot segments but still allows resolved in-root paths', () => {
        const result = validatePath('./src/../notes/todo.txt', workingDir);
        expect(result).toMatchObject({
            valid: true,
            resolvedPath: resolve(canonicalWorkingDir, 'notes', 'todo.txt'),
        });
    });

    it('rejects traversal after normalization when target resolves outside root', () => {
        const result = validatePath('./src/../../../outside.txt', workingDir);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('outside the allowed directories');
    });

    it('should allow the working directory itself', () => {
        expect(validatePath('.', workingDir)).toMatchObject({ valid: true, resolvedPath: canonicalWorkingDir });
        expect(validatePath(workingDir, workingDir)).toMatchObject({ valid: true, resolvedPath: resolve(workingDir) });
    });

    it('allows paths inside additional allowed directories', () => {
        const testBase = mkdtempSync(join(tmpdir(), 'happier-pathSecurity-extra-'));
        const extra = join(testBase, 'uploads');
        try {
            mkdirSync(extra, { recursive: true });
            expect(validatePath(join(extra, 'session', 'file.jpg'), workingDir, [extra]).valid).toBe(true);
            expect(validatePath(join(extra, 'abc', 'img.png'), workingDir, [extra]).valid).toBe(true);
        } finally {
            rmSync(testBase, { recursive: true, force: true });
        }
    });

    it('rejects traversal outside additional allowed directory', () => {
        const testBase = mkdtempSync(join(tmpdir(), 'happier-pathSecurity-traversal-'));
        const extra = join(testBase, 'uploads');
        try {
            mkdirSync(extra, { recursive: true });
            const result = validatePath(join(extra, '..', '..', 'etc', 'passwd'), workingDir, [extra]);
            expect(result.valid).toBe(false);
        } finally {
            rmSync(testBase, { recursive: true, force: true });
        }
    });

    it('prevents symlink traversal out of an allowed directory', () => {
        const testBase = join(tmpdir(), `happier-pathSecurity-${Date.now()}`);
        const allowedDir = join(testBase, 'uploads');
        const outsideBase = join(tmpdir(), `happier-pathSecurity-outside-${Date.now()}`);
        const outsideDir = join(outsideBase, 'outside');
        const symlinkPath = join(allowedDir, 'evil-link');

        try {
            mkdirSync(allowedDir, { recursive: true });
            mkdirSync(outsideDir, { recursive: true });
            symlinkSync(outsideDir, symlinkPath);

            // The symlink resolves outside the working dir, so it must be rejected.
            const result = validatePath(join(symlinkPath, 'secret.txt'), allowedDir);
            expect(result.valid).toBe(false);
        } finally {
            if (existsSync(testBase)) {
                rmSync(testBase, { recursive: true, force: true });
            }
            if (existsSync(outsideBase)) {
                rmSync(outsideBase, { recursive: true, force: true });
            }
        }
    });

    it('accepts paths that only differ by canonical realpath aliases', () => {
        const testBase = join(tmpdir(), `happier-pathSecurity-canonical-${Date.now()}`);
        const realWorkspace = join(testBase, 'real-workspace');
        const aliasWorkspace = join(testBase, 'alias-workspace');

        try {
            mkdirSync(realWorkspace, { recursive: true });
            symlinkSync(realWorkspace, aliasWorkspace);

            const result = validatePath(join(realWorkspace, 'notes.txt'), aliasWorkspace);
            expect(result).toMatchObject({
                valid: true,
                resolvedPath: join(realWorkspace, 'notes.txt'),
            });
        } finally {
            if (existsSync(testBase)) {
                rmSync(testBase, { recursive: true, force: true });
            }
        }
    });

    it('rejects when working directory is missing or invalid', () => {
        expect(validatePath('file.txt', '')).toEqual({
            valid: false,
            error: 'Access denied: Invalid working directory',
        });
        expect(validatePath('file.txt', null as unknown as string)).toEqual({
            valid: false,
            error: 'Access denied: Invalid working directory',
        });
    });
});

describe('validateWorkspaceInspectionPath', () => {
    it('allows canonical absolute workspace inspection paths outside the working tree', () => {
        expect(validateWorkspaceInspectionPath('/tmp/workspaces/demo')).toEqual({
            valid: true,
            resolvedPath: resolve('/tmp/workspaces/demo'),
        });
    });

    it('rejects relative workspace inspection paths', () => {
        expect(validateWorkspaceInspectionPath('./demo')).toEqual({
            valid: false,
            error: 'Attached workspace candidate path must be absolute',
        });
    });

    it('rejects workspace inspection paths containing null bytes', () => {
        expect(validateWorkspaceInspectionPath('/tmp/demo\0repo')).toEqual({
            valid: false,
            error: 'Attached workspace candidate path contains invalid characters',
        });
    });
});


describe('dedicated private native domain restriction', () => {
    it.skipIf(process.platform === 'win32').each(['raw.bin', 'missing/future.bin'])(
        '[path-identity] refuses a private effective path through a symlink before ..: %s', (suffix) => {
            const root = mkdtempSync(join(tmpdir(), 'happier-private-path-identity-'));
            try {
                const privateDomain = join(root, 'private');
                const ordinary = join(root, 'ordinary');
                mkdirSync(join(privateDomain, 'child'), { recursive: true });
                mkdirSync(ordinary);
                writeFileSync(join(privateDomain, '.muninn-private-native-domain'), 'restriction');
                const original = Buffer.from([0, 255, 128, 10]);
                writeFileSync(join(privateDomain, 'raw.bin'), original);
                writeFileSync(join(ordinary, 'raw.bin'), Buffer.from([1, 2, 3]));
                symlinkSync(join(privateDomain, 'child'), join(ordinary, 'alias'));
                // Preserve the actual open path; join/resolve would collapse away the symlink.
                const requested = `${ordinary}/alias/../${suffix}`;
                if (suffix === 'raw.bin') {
                    expect(realpathSync.native(requested)).toBe(join(privateDomain, 'raw.bin'));
                    expect(readFileSync(requested)).toEqual(original);
                    expect(readFileSync(resolve(requested))).not.toEqual(original);
                }
                expect(validateOrdinaryReaderPath(requested).valid).toBe(false);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        },
    );

    it.skipIf(process.platform === 'win32')('[path-identity] preserves the lexical restriction when a symlink leaves a marked domain', () => {
        const root = mkdtempSync(join(tmpdir(), 'happier-private-lexical-identity-'));
        try {
            const privateDomain = join(root, 'private');
            const ordinary = join(root, 'ordinary');
            mkdirSync(privateDomain);
            mkdirSync(join(ordinary, 'child'), { recursive: true });
            writeFileSync(join(privateDomain, '.muninn-private-native-domain'), 'restriction');
            writeFileSync(join(ordinary, 'raw.bin'), Buffer.from([0, 255, 128, 10]));
            symlinkSync(join(ordinary, 'child'), join(privateDomain, 'alias'));
            const requested = `${privateDomain}/alias/../raw.bin`;
            expect(realpathSync.native(requested)).toBe(join(ordinary, 'raw.bin'));
            expect(validateOrdinaryReaderPath(requested).valid).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it.skipIf(process.platform === 'win32')('[path-identity] allows ordinary effective paths and missing descendants', () => {
        const root = mkdtempSync(join(tmpdir(), 'happier-ordinary-path-identity-'));
        try {
            mkdirSync(join(root, 'actual', 'child'), { recursive: true });
            symlinkSync(join(root, 'actual', 'child'), join(root, 'alias'));
            const original = Buffer.from([255, 0, 128, 10]);
            writeFileSync(join(root, 'actual', 'raw.bin'), original);
            writeFileSync(join(root, 'raw.bin'), Buffer.from([1, 2, 3]));
            const requested = `${root}/alias/../raw.bin`;
            expect(validateOrdinaryReaderPath(requested).valid).toBe(true);
            expect(readFileSync(requested)).toEqual(original);
            expect(readFileSync(resolve(requested))).not.toEqual(original);
            expect(validateOrdinaryReaderPath(`${root}/alias/../missing/future.bin`).valid).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('refuses legacy workspace reads through aliases and missing descendants while preserving ordinary neighbors', () => {
        const root = mkdtempSync(join(tmpdir(), 'happier-private-path-'));
        try {
            const privateDomain = join(root, 'private');
            const ordinary = join(root, 'ordinary');
            mkdirSync(privateDomain);
            mkdirSync(ordinary);
            writeFileSync(join(privateDomain, '.muninn-private-native-domain'), 'restriction');
            writeFileSync(join(privateDomain, 'raw.bin'), Buffer.from([0, 255, 10]));
            symlinkSync(privateDomain, join(root, 'alias'));
            for (const target of [join(privateDomain, 'raw.bin'), join(root, 'alias', 'missing', 'later.bin')]) {
                expect(validatePath(target, root).valid).toBe(false);
            }
            expect(validatePath(join(ordinary, 'future', 'record'), root).valid).toBe(true);
            expect(validatePath(join(root, 'ordinary'), root).valid).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
