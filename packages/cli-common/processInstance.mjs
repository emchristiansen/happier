import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function normalizePid(pid) {
  const value = Number(pid);
  return Number.isInteger(value) && value > 1 ? value : null;
}

function runProbe(command, args, { spawnSyncImpl }) {
  const result = spawnSyncImpl(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result?.error || result?.status !== 0) return null;
  const value = String(result?.stdout ?? '').trim();
  return value || null;
}

/**
 * The Linux process-instance fingerprint read from `/proc/<pid>/stat` alone (never a child process),
 * or null when the process or its start time is unreadable. The same value
 * `readProcessInstanceFingerprintSync` returns on Linux when `/proc` is readable.
 */
export function readLinuxProcProcessInstanceFingerprintSync(pid, { readFileSyncImpl = readFileSync } = {}) {
  const normalizedPid = normalizePid(pid);
  if (!normalizedPid) return null;
  try {
    const stat = String(readFileSyncImpl(`/proc/${normalizedPid}/stat`, 'utf8'));
    const closingParen = stat.lastIndexOf(')');
    const fieldsAfterCommand = closingParen >= 0
      ? stat.slice(closingParen + 1).trim().split(/\s+/)
      : [];
    const startTimeTicks = fieldsAfterCommand[19];
    return /^\d+$/.test(String(startTimeTicks ?? '')) ? `linux-proc:${startTimeTicks}` : null;
  } catch {
    return null;
  }
}

export function readProcessInstanceFingerprintSync(pid, {
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  readFileSyncImpl = readFileSync,
} = {}) {
  const normalizedPid = normalizePid(pid);
  if (!normalizedPid) return null;

  if (platform === 'linux') {
    const fromProc = readLinuxProcProcessInstanceFingerprintSync(normalizedPid, { readFileSyncImpl });
    if (fromProc) return fromProc;
    // Fall through to the portable POSIX probe.
  }

  if (platform === 'win32') {
    const script = [
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${normalizedPid}" -ErrorAction Stop`,
      'if ($null -eq $p) { exit 3 }',
      '$p.CreationDate.ToUniversalTime().ToString("O")',
    ].join('; ');
    const value = runProbe('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ], { spawnSyncImpl });
    return value ? `win32-cim:${value}` : null;
  }

  const value = runProbe('ps', ['-o', 'lstart=', '-p', String(normalizedPid)], { spawnSyncImpl });
  return value ? `${platform}-ps:${value}` : null;
}

export function processInstanceFingerprintMatches(expected, observed) {
  const normalizedExpected = String(expected ?? '').trim();
  const normalizedObserved = String(observed ?? '').trim();
  return Boolean(normalizedExpected && normalizedObserved && normalizedExpected === normalizedObserved);
}
