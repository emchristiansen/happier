import { describe, expect, it } from 'vitest';
import { stripNestedSessionDetectionEnv } from './stripNestedSessionDetectionEnv';

describe('stripNestedSessionDetectionEnv', () => {
  it('removes nested session detection env vars', () => {
    const input: NodeJS.ProcessEnv = {
      PATH: '/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'parent',
      HERDR_ENV: '1',
      HERDR_SOCKET_PATH: '/tmp/herdr.sock',
    };

    const output = stripNestedSessionDetectionEnv(input);

    expect(output.PATH).toBe('/bin');
    expect(output.CLAUDECODE).toBeUndefined();
    expect(output.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(output.HERDR_ENV).toBeUndefined();
    expect(output.HERDR_SOCKET_PATH).toBe('/tmp/herdr.sock');
  });

  it('does not mutate the input object', () => {
    const input: NodeJS.ProcessEnv = { CLAUDECODE: '1' };
    stripNestedSessionDetectionEnv(input);
    expect(input.CLAUDECODE).toBe('1');
  });
});
