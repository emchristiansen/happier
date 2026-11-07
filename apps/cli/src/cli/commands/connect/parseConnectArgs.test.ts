import { describe, expect, it } from 'vitest';

import { parseConnectArgs } from './parseConnectArgs';

describe('parseConnectArgs', () => {
  it('parses native import and its provider-declared source', () => {
    expect(parseConnectArgs(['agy', '--import', '--source', 'acp', '--profile', 'personal']).options).toMatchObject({ import: true, source: 'acp', profileId: 'personal' });
  });
  it('parses --device and --profile and a subcommand', () => {
    const res = parseConnectArgs(['codex', '--device', '--profile', 'work']);
    expect(res.subcommand).toBe('codex');
    expect(res.options.profileId).toBe('work');
    expect(res.options.device).toBe(true);
  });

  it('defaults profile to default', () => {
    const res = parseConnectArgs(['codex']);
    expect(res.options.profileId).toBe('default');
  });

  it('parses --oauth', () => {
    const res = parseConnectArgs(['claude', '--oauth']);
    expect(res.options.oauth).toBe(true);
  });

  it('parses --api-key', () => {
    const res = parseConnectArgs(['claude', '--api-key']);
    expect(res.options.apiKey).toBe(true);
  });

  it('parses --token', () => {
    const res = parseConnectArgs(['github', '--token']);
    expect(res.options.token).toBe(true);
  });

  describe('profileFlag', () => {
    it('is absent without --profile', () => {
      expect(parseConnectArgs(['status']).profileFlag).toEqual({ kind: 'absent' });
    });

    it('carries the exact value given to --profile', () => {
      const res = parseConnectArgs(['status', '--profile', 'work']);
      expect(res.subcommand).toBe('status');
      expect(res.profileFlag).toEqual({ kind: 'value', profileId: 'work' });
    });

    it.each([
      ['no value follows', ['status', '--profile']],
      ['the value is empty', ['status', '--profile', '']],
      ['the value is blank', ['status', '--profile', '   ']],
      ['another flag follows', ['status', '--profile', '--all']],
      ['a long flag follows', ['status', '--profile', '--json']],
      ['a short help flag follows', ['status', '--profile', '-h']],
      ['another short flag follows', ['status', '--profile', '-x']],
    ])('reports a missing value when %s', (_case, args) => {
      expect(parseConnectArgs(args).profileFlag).toEqual({ kind: 'missing_value' });
    });

    it('leaves the connect <target> default profile unchanged', () => {
      expect(parseConnectArgs(['codex', '--profile']).options.profileId).toBe('default');
    });
  });
});
