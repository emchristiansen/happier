import { describe, expect, it } from 'vitest';
import { parseCliAcquisitionProgress, readCliAcquisitionFailurePhase } from './acquisitionProgress.js';

describe('CLI acquisition progress contract', () => {
  it('accepts optional counters and extension fields while rejecting unknown or invalid progress', () => {
    expect(parseCliAcquisitionProgress({ phase: 'downloading', receivedBytes: 0, extra: true })).toEqual({ phase: 'downloading', receivedBytes: 0 });
    expect(parseCliAcquisitionProgress({ phase: 'downloading', receivedBytes: 12, totalBytes: 24 })).toEqual({ phase: 'downloading', receivedBytes: 12, totalBytes: 24 });
    for (const value of [null, {}, { phase: 'future' }, { phase: 'downloading', totalBytes: 0 },
      { phase: 'downloading', receivedBytes: -1 }, { phase: 'downloading', receivedBytes: 1.5 }]) {
      expect(parseCliAcquisitionProgress(value)).toBeNull();
    }
  });
  it('recognizes only acquisition phase failures and retains a structured cause', () => {
    expect(readCliAcquisitionFailurePhase('cli_acquisition_verifying_failed')).toBe('verifying');
    expect(readCliAcquisitionFailurePhase('cli_acquisition_future_failed')).toBeNull();
    expect(readCliAcquisitionFailurePhase('first_party_component_install_failed')).toBeNull();
    expect(parseCliAcquisitionProgress({ phase: 'installing', failure: { cause: 'disk_full' } })).toEqual({ phase: 'installing', failure: { cause: 'disk_full' } });
  });
});
