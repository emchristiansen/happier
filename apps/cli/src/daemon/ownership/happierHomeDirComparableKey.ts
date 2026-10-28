/** Unknown homes never establish authority over an installed service. */
export function happierHomeDirsMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  const leftKey = resolveHappierHomeDirComparableKey(left);
  return leftKey !== null && leftKey === resolveHappierHomeDirComparableKey(right);
}

export function resolveHappierHomeDirComparableKey(homeDir: string | null | undefined): string | null {
  let value = String(homeDir ?? '').trim();
  if (!value) {
    return null;
  }

  value = value.replace(/[\\/]+$/, '');
  if (!value) {
    return null;
  }

  const posixWindowsDriveMatch = /^\/([a-zA-Z])\/(.*)$/u.exec(value);
  if (posixWindowsDriveMatch) {
    const driveLetter = posixWindowsDriveMatch[1]?.toLowerCase() ?? '';
    const remainder = String(posixWindowsDriveMatch[2] ?? '').replace(/[\\]+/g, '/');
    value = `${driveLetter}:/${remainder}`;
  }

  const isWindowsishPath =
    /^[a-zA-Z]:[\\/]/.test(value)
    || value.startsWith('\\\\')
    || value.startsWith('//')
    || value.includes('\\');

  if (isWindowsishPath) {
    if (value.startsWith('\\\\')) {
      value = value.replace(/^\\\\+/, '//');
    }
    value = value.replace(/[\\]+/g, '/');
    value = value.replace(/\/{3,}/g, '//');
    value = value.toLowerCase();
    value = value.replace(/\/+$/, '');
  }

  return value || null;
}
