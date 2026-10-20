import { describe, expect, it } from 'vitest';

import {
  processInstanceFingerprintScheme,
  processInstanceFingerprintsProveDifferentInstances,
} from './processInstanceFingerprintEvidence';

const PS_FALLBACK = 'linux-ps:Mon Oct 20 10:00:00 2026';

describe('process-instance fingerprint evidence', () => {
  it('reads the scheme as the text before the first colon', () => {
    expect(processInstanceFingerprintScheme('linux-proc:987654')).toBe('linux-proc');
    expect(processInstanceFingerprintScheme('darwin-ps:Mon Aug 12 01:53:03 2026')).toBe('darwin-ps');
    expect(processInstanceFingerprintScheme('win32-cim:2026-07-23T12:34:56.0000000Z')).toBe('win32-cim');
    expect(processInstanceFingerprintScheme('no-scheme')).toBeNull();
    expect(processInstanceFingerprintScheme(':value')).toBeNull();
    expect(processInstanceFingerprintScheme(null)).toBeNull();
  });

  it('proves different instances only from two different fingerprints of one scheme', () => {
    expect(processInstanceFingerprintsProveDifferentInstances('linux-proc:1', 'linux-proc:2')).toBe(true);
    expect(processInstanceFingerprintsProveDifferentInstances('linux-proc:1', 'linux-proc:1')).toBe(false);
    // The same living pid read from /proc and then through the ps fallback.
    expect(processInstanceFingerprintsProveDifferentInstances('linux-proc:1', PS_FALLBACK)).toBe(false);
    expect(processInstanceFingerprintsProveDifferentInstances(PS_FALLBACK, 'linux-proc:1')).toBe(false);
    expect(processInstanceFingerprintsProveDifferentInstances('a', 'b')).toBe(false);
    expect(processInstanceFingerprintsProveDifferentInstances('linux-proc:1', null)).toBe(false);
    expect(processInstanceFingerprintsProveDifferentInstances(undefined, 'linux-proc:1')).toBe(false);
  });
});
