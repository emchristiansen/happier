import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function isSupportedHerdrVersion(value: string): boolean {
  const version = value.trim().replace(/^herdr\s+/, '');
  const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!parsed) return false;
  const major = Number(parsed[1]);
  const minor = Number(parsed[2]);
  const patch = Number(parsed[3]);
  return major > 0 || minor > 9 || (minor === 9 && patch >= 2);
}

export async function resolveHerdrRuntimeBinary(params: Readonly<{
  actionTimeoutMs: number;
}>): Promise<string | null> {
  const binary = process.env.HERDR_BIN_PATH?.trim() || 'herdr';
  try {
    const { stdout } = await execFileAsync(binary, ['--version'], {
      timeout: params.actionTimeoutMs,
      windowsHide: true,
    });
    return isSupportedHerdrVersion(stdout) ? binary : null;
  } catch {
    return null;
  }
}
