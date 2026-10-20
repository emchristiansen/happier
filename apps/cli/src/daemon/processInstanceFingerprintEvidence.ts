/**
 * The method a process-instance fingerprint was read with (`linux-proc`, `linux-ps`, `darwin-ps`,
 * `win32-cim`; see `readProcessInstanceFingerprintSync`): the text before the first `:`, or null.
 */
export function processInstanceFingerprintScheme(fingerprint: string | null | undefined): string | null {
  const value = String(fingerprint ?? '').trim();
  const separator = value.indexOf(':');
  return separator > 0 ? value.slice(0, separator) : null;
}

/**
 * True only when two fingerprints read with the same scheme differ, which proves they name different
 * process instances. One living pid can be read under two schemes (Linux falls back from `/proc` to
 * `ps`), so a difference across schemes, or without a scheme, proves nothing about the instance.
 */
export function processInstanceFingerprintsProveDifferentInstances(
  expected: string | null | undefined,
  observed: string | null | undefined,
): boolean {
  const normalizedExpected = String(expected ?? '').trim();
  const normalizedObserved = String(observed ?? '').trim();
  const scheme = processInstanceFingerprintScheme(normalizedExpected);
  return scheme !== null
    && scheme === processInstanceFingerprintScheme(normalizedObserved)
    && normalizedExpected !== normalizedObserved;
}
