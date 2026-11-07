import { describe, expect, it } from 'vitest';
import { resolveServerProfileApiUrl } from './serverProfileApiUrl';

describe('profile API endpoint selection', () => {
  it('falls back to the canonical endpoint when the local endpoint normalizes to empty', () => {
    expect(resolveServerProfileApiUrl({ serverUrl: 'https://relay.example.test/', localServerUrl: ' /// ' }))
      .toBe('https://relay.example.test');
  });

  it('keeps the normalized local API endpoint when configured', () => {
    expect(resolveServerProfileApiUrl({ serverUrl: 'https://relay.example.test', localServerUrl: ' http://127.0.0.1:3005/ ' }))
      .toBe('http://127.0.0.1:3005');
  });
});
