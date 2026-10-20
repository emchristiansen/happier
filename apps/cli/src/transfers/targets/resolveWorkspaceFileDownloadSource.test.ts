import { deflateRawSync } from 'node:zlib';
import { buildZipArchive } from '../download/buildZipArchive';
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { SESSION_RPC_FILE_TRANSFER_SIZE_LIMIT_ERROR } from '../policy/sessionRpcTransferPolicy';
import { resolveWorkspaceFileDownloadSource } from './resolveWorkspaceFileDownloadSource';

const createdPaths = new Set<string>();

function createWorkspace(): string {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-transfer-download-source-'));
    createdPaths.add(workspace);
    return workspace;
}

afterEach(() => {
    for (const path of createdPaths) {
        rmSync(path, { recursive: true, force: true });
    }
    createdPaths.clear();
});

describe('resolveWorkspaceFileDownloadSource', () => {
    it('allows absolute download sources outside the default directory by default', async () => {
        const workspace = createWorkspace();
        const outside = createWorkspace();
        writeFileSync(join(outside, 'hello.txt'), 'hello\n', 'utf8');

        await expect(
            resolveWorkspaceFileDownloadSource({
                workingDirectory: workspace,
                path: join(outside, 'hello.txt'),
                asZip: false,
            }),
        ).resolves.toMatchObject({
            success: true,
            source: {
                filePath: join(outside, 'hello.txt'),
            },
        });
    });

    it('returns a direct file source for non-zip downloads', async () => {
        const workspace = createWorkspace();
        writeFileSync(join(workspace, 'hello.txt'), 'hello\n', 'utf8');

        await expect(
            resolveWorkspaceFileDownloadSource({
                workingDirectory: workspace,
                path: 'hello.txt',
                asZip: false,
            }),
        ).resolves.toMatchObject({
            success: true,
            source: {
                deleteFileOnClose: false,
                sizeBytes: 6,
                name: 'hello.txt',
            },
        });
        const result = await resolveWorkspaceFileDownloadSource({
            workingDirectory: workspace,
            path: 'hello.txt',
            asZip: false,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.source.filePath.endsWith('/hello.txt')).toBe(true);
            expect(result.source.filePath).toContain('happier-transfer-download-source-');
        }
    });

    it('rejects directory downloads unless zip mode is requested', async () => {
        const workspace = createWorkspace();
        mkdirSync(join(workspace, 'folder'), { recursive: true });

        await expect(
            resolveWorkspaceFileDownloadSource({
                workingDirectory: workspace,
                path: 'folder',
                asZip: false,
            }),
        ).resolves.toEqual({
            success: false,
            error: 'Download is only supported for files',
        });
    });

    it('rejects absolute download sources outside configured restricted roots', async () => {
        const workspace = createWorkspace();
        const outside = createWorkspace();
        writeFileSync(join(outside, 'hello.txt'), 'hello\n', 'utf8');

        const result = await resolveWorkspaceFileDownloadSource({
            workingDirectory: workspace,
            path: join(outside, 'hello.txt'),
            asZip: false,
            accessPolicy: { kind: 'restrictedRoots', roots: [workspace] },
        });

        expect(result).toMatchObject({ success: false });
        expect(String((result as { error?: string }).error ?? '')).toContain('outside the allowed directories');
    });

    it('builds a temporary zip source for directory downloads', async () => {
        const workspace = createWorkspace();
        mkdirSync(join(workspace, 'folder'), { recursive: true });
        writeFileSync(join(workspace, 'folder', 'hello.txt'), 'hello\n', 'utf8');

        const result = await resolveWorkspaceFileDownloadSource({
            workingDirectory: workspace,
            path: 'folder',
            asZip: true,
        });

        expect(result.success).toBe(true);
        if (!result.success) {
            return;
        }

        expect(result.source.deleteFileOnClose).toBe(true);
        expect(result.source.name).toBe('folder.zip');
        expect(result.source.sizeBytes).toBeGreaterThan(0);
        expect(existsSync(result.source.filePath)).toBe(true);
        createdPaths.add(result.source.filePath);
    });

    it('fails closed when the selected session-routed size limit is exceeded', async () => {
        const workspace = createWorkspace();
        writeFileSync(join(workspace, 'hello.txt'), 'hello\n', 'utf8');

        await expect(
            resolveWorkspaceFileDownloadSource({
                workingDirectory: workspace,
                path: 'hello.txt',
                asZip: false,
                sessionRpcTransferMaxBytes: 4,
            }),
        ).resolves.toEqual({
            success: false,
            error: SESSION_RPC_FILE_TRANSFER_SIZE_LIMIT_ERROR,
        });
    });
});


describe('dedicated private native domain archive boundary', () => {
    it('omits a private subtree from newly generated parent archives while preserving original ordinary bytes', async () => {
        const workspace = createWorkspace();
        const privateDomain = join(workspace, 'private');
        mkdirSync(privateDomain);
        writeFileSync(join(privateDomain, '.muninn-private-native-domain'), 'restriction');
        const privateBytes = Buffer.concat([Buffer.from('private original raw bytes '), Buffer.from([0, 255, 128, 10])]);
        const ordinaryBytes = Buffer.from([0, 255, 128, 10, 65, 66, 67, 0]);
        writeFileSync(join(privateDomain, 'private-raw-record.bin'), privateBytes);
        writeFileSync(join(workspace, 'ordinary-raw-record.bin'), ordinaryBytes);
        const result = await resolveWorkspaceFileDownloadSource({ workingDirectory: workspace, path: workspace, asZip: true });
        expect(result.success).toBe(true);
        if (!result.success) throw new Error('ordinary parent export failed');
        createdPaths.add(result.source.filePath);
        const archiveBytes = readFileSync(result.source.filePath);
        expect(archiveBytes.includes(Buffer.from('private-raw-record.bin'))).toBe(false);
        expect(archiveBytes.includes(deflateRawSync(privateBytes, { level: 9 }))).toBe(false);
        expect(archiveBytes.includes(Buffer.from('ordinary-raw-record.bin'))).toBe(true);
        // ZIP uses raw deflate: compare the full original binary member encoding.
        expect(archiveBytes.includes(deflateRawSync(ordinaryBytes, { level: 9 }))).toBe(true);
        expect(readFileSync(join(workspace, 'ordinary-raw-record.bin'))).toEqual(ordinaryBytes);
        expect(readFileSync(join(privateDomain, 'private-raw-record.bin'))).toEqual(privateBytes);
    });

    it('refuses direct builder use on a private root before creating an archive', async () => {
        const workspace = createWorkspace();
        const privateDomain = join(workspace, 'private');
        mkdirSync(privateDomain);
        writeFileSync(join(privateDomain, '.muninn-private-native-domain'), 'restriction');
        writeFileSync(join(privateDomain, 'raw.bin'), Buffer.from([0, 255, 128]));
        const zipPath = join(workspace, 'must-not-exist.zip');
        await expect(buildZipArchive({ sourcePath: privateDomain, zipPath, excludedTopLevelDirs: [], maxEntryCount: 100,
            maxTotalBytes: 1024 * 1024, maxOutputBytes: 1024 * 1024 })).rejects.toThrow('private native domain');
        expect(existsSync(zipPath)).toBe(false);
    });
});
