import { chmod, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';

const { renameSpy, writeFileSpy } = vi.hoisted(() => ({
  renameSpy: vi.fn(),
  writeFileSpy: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  renameSpy.mockImplementation(actual.rename);
  writeFileSpy.mockImplementation(actual.writeFile);
  return {
    ...actual,
    rename: renameSpy,
    writeFile: writeFileSpy,
  };
});

describe('Claude Code credential file write policy', () => {
  afterEach(() => {
    if (vi.isMockFunction(logger.info)) vi.mocked(logger.info).mockRestore();
    if (vi.isMockFunction(logger.debug)) vi.mocked(logger.debug).mockRestore();
    renameSpy.mockClear();
    writeFileSpy.mockClear();
  });

  it('does not replace .credentials.json when the materialized fingerprint is unchanged', async () => {
    const consoleInfo = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const fileDiagnostic = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const { resolveClaudeCodeCredentialsFilePath, writeClaudeCodeCredentialsFile } = await import(
      './claudeCodeCredentialFile'
    );
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-credential-skip-'));
    const payload = {
      claudeAiOauth: {
        accessToken: 'stable-access-placeholder',
        refreshToken: 'stable-refresh-placeholder',
        expiresAt: 1_800_000_000_000,
        scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
      },
    };

    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload,
      preserveNewerExistingCredential: false,
    });
    renameSpy.mockClear();
    writeFileSpy.mockClear();

    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload,
      preserveNewerExistingCredential: false,
    });

    expect(renameSpy).not.toHaveBeenCalled();
    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(fileDiagnostic).toHaveBeenCalledWith(
      '[DAEMON RUN] Claude Code credential file decision',
      expect.objectContaining({ decision: 'skip_fingerprint_match' }),
    );
    expect(consoleInfo).not.toHaveBeenCalled();
    await expect(readFile(resolveClaudeCodeCredentialsFilePath(claudeConfigDir), 'utf8')).resolves.toContain(
      'stable-access-placeholder',
    );
  });

  it('repairs credential file permissions to 0600 on the unchanged fingerprint-skip path', async () => {
    if (process.platform === 'win32') return;
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    const { resolveClaudeCodeCredentialsFilePath, writeClaudeCodeCredentialsFile } = await import(
      './claudeCodeCredentialFile'
    );
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-credential-perms-'));
    const credentialPath = resolveClaudeCodeCredentialsFilePath(claudeConfigDir);
    const payload = {
      claudeAiOauth: {
        accessToken: 'stable-access-placeholder',
        refreshToken: 'stable-refresh-placeholder',
        expiresAt: 1_800_000_000_000,
        scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
      },
    };

    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload,
      preserveNewerExistingCredential: false,
    });
    // Simulate an external tool / old writer leaving the file world-and-group readable.
    await chmod(credentialPath, 0o644);
    renameSpy.mockClear();
    writeFileSpy.mockClear();

    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload,
      preserveNewerExistingCredential: false,
    });

    // Content is unchanged (no rewrite), but the mode must be repaired to 0600.
    expect(renameSpy).not.toHaveBeenCalled();
    expect(writeFileSpy).not.toHaveBeenCalled();
    const mode = (await stat(credentialPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('commits a genuine credential change with a temp-file rename and never truncates the live file', async () => {
    const { resolveClaudeCodeCredentialsFilePath, writeClaudeCodeCredentialsFile } = await import(
      './claudeCodeCredentialFile'
    );
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-credential-atomic-'));
    const credentialPath = resolveClaudeCodeCredentialsFilePath(claudeConfigDir);
    const buildPayload = (accessToken: string) => ({
      claudeAiOauth: {
        accessToken,
        refreshToken: 'refresh-placeholder',
        expiresAt: 1_800_000_000_000,
        scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
      },
    });

    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload: buildPayload('first-access-placeholder'),
      preserveNewerExistingCredential: false,
    });
    renameSpy.mockClear();
    writeFileSpy.mockClear();

    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload: buildPayload('rotated-access-placeholder'),
      preserveNewerExistingCredential: false,
    });

    expect(writeFileSpy).toHaveBeenCalledTimes(1);
    const [tempPath] = writeFileSpy.mock.calls[0] ?? [];
    expect(typeof tempPath).toBe('string');
    expect(String(tempPath)).not.toBe(credentialPath);
    expect(renameSpy).toHaveBeenCalledWith(tempPath, credentialPath);
    await expect(readFile(credentialPath, 'utf8')).resolves.toContain('rotated-access-placeholder');
  });
});
