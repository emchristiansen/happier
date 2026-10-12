import { describe, expect, it } from 'vitest';

import { createRuntimeContextPrefixArgs, parseRuntimeContextPrefixArgs } from './runtimeContextArgv';

describe('runtime context credential boundary', () => {
  it('does not render URL credentials into a saved command', () => {
    const url = 'https://sentinel-user:sentinel-password@server.example.test';
    expect(() => createRuntimeContextPrefixArgs({ HAPPIER_SERVER_URL: url }))
      .toThrow('Invalid --runtime-context payload');
  });

  it('rejects URL credentials on input with a sanitized diagnostic', () => {
    const payload = Buffer.from(JSON.stringify({
      HAPPIER_WEBAPP_URL: 'https://sentinel-user:sentinel-password@web.example.test',
    })).toString('base64url');
    let failure: unknown;
    try {
      parseRuntimeContextPrefixArgs(['--runtime-context', payload, 'resume', 'session-sentinel']);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toBe('Error: Invalid --runtime-context payload');
    expect(String(failure)).not.toContain('sentinel-password');
    expect(String(failure)).not.toContain(payload);
  });
});
