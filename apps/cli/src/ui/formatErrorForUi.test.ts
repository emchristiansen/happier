import { describe, expect, it } from 'vitest';
import { formatErrorForUi } from './formatErrorForUi';

describe('formatErrorForUi', () => {
  it('formats Error instances using stack when available', () => {
    const err = new Error('boom');
    err.stack = 'STACK';
    expect(formatErrorForUi(err)).toBe('STACK');
  });

  it('falls back to Error.message when stack is unavailable', () => {
    const err = new Error('boom');
    err.stack = '';
    expect(formatErrorForUi(err)).toBe('boom');
  });

  it('shows nested runtime and cleanup failures with redacted causes', () => {
    const runtimeError = new Error('Provider request failed', {
      cause: {
        message: 'Authorization: Bearer provider-secret-token',
        access_token: 'provider-access-token',
      },
    });
    const cleanupError = new Error('Owned provider termination failed', {
      cause: new Error('Cleanup refused: client_secret=provider-client-secret'),
    });
    const queryError = new AggregateError(
      [runtimeError, cleanupError],
      'Claude process exit was unverified and cleanup failed',
      { cause: runtimeError },
    );
    const error = new AggregateError(
      [queryError, new Error('Terminal teardown failed')],
      'Claude runtime failed with incomplete owned process cleanup',
      { cause: queryError },
    );

    const out = formatErrorForUi(error, { maxChars: 12_000 });

    expect(out).toContain('Provider request failed');
    expect(out).toContain('Owned provider termination failed');
    expect(out).toContain('Terminal teardown failed');
    expect(out).toContain('Cleanup refused');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('provider-secret-token');
    expect(out).not.toContain('provider-access-token');
    expect(out).not.toContain('provider-client-secret');
  });

  it('shows a cause without requiring an AggregateError and handles cyclic causes', () => {
    const error = new Error('Provider failed', { cause: new Error('Request rejected') });
    const cause = error.cause;
    if (!(cause instanceof Error)) throw new Error('Expected an Error cause');
    cause.cause = error;

    const out = formatErrorForUi(error);

    expect(out).toContain('Provider failed');
    expect(out).toContain('Request rejected');
    expect(out).toContain('[Circular]');
  });

  it('preserves the same failure in aggregate members and cause', () => {
    const runtimeError = new Error('Provider request failed', {
      cause: { access_token: 'shared-provider-token' },
    });
    const error = new AggregateError(
      [runtimeError, new Error('Owned provider termination failed')],
      'Claude runtime failed with incomplete owned process cleanup',
      { cause: runtimeError },
    );

    const out = formatErrorForUi(error);
    const failure = expect.objectContaining({
      name: 'Error',
      message: 'Provider request failed',
      stack: runtimeError.stack,
      cause: { access_token: '[REDACTED]' },
    });
    expect(JSON.parse(out)).toEqual(expect.objectContaining({
      errors: [failure, expect.objectContaining({ message: 'Owned provider termination failed' })],
      cause: failure,
    }));
    expect(out).not.toContain('[Circular]');
    expect(out).not.toContain('shared-provider-token');
  });

  it('preserves shared objects while marking only their actual cycles', () => {
    const shared: { count: bigint; date: Date; self?: unknown } = {
      count: 17n,
      date: new Date('2026-10-14T00:00:00.000Z'),
    };
    shared.self = shared;

    const out = formatErrorForUi({ first: shared, second: shared });
    const branch = { count: '17', date: '2026-10-14T00:00:00.000Z', self: '[Circular]' };

    expect(JSON.parse(out)).toEqual({ first: branch, second: branch });
  });

  it('formats non-Error values as strings', () => {
    expect(formatErrorForUi('nope')).toBe('nope');
    expect(formatErrorForUi(123)).toBe('123');
  });

  it('formats plain objects using JSON when possible', () => {
    const out = formatErrorForUi({ code: 'E_FAIL', message: 'boom' });
    expect(out).toContain('E_FAIL');
    expect(out).toContain('boom');
    expect(out).not.toBe('[object Object]');
  });

  it('redacts sensitive provider error details', () => {
    const out = formatErrorForUi({
      message: 'Authorization: Bearer provider-secret-token',
      response: {
        data: {
          access_token: 'provider-access-token',
          refresh_token: 'provider-refresh-token',
          client_secret: 'provider-client-secret',
        },
      },
    });

    expect(out).not.toContain('provider-secret-token');
    expect(out).not.toContain('provider-access-token');
    expect(out).not.toContain('provider-refresh-token');
    expect(out).not.toContain('provider-client-secret');
    expect(out).toContain('[REDACTED]');
  });

  it('truncates long output with a suffix', () => {
    const input = 'x'.repeat(1201);
    const out = formatErrorForUi(input, { maxChars: 1000 });
    expect(out).toContain('…[truncated]');
    expect(out.startsWith('x'.repeat(1000))).toBe(true);
  });

  it('clamps maxChars to at least 1000', () => {
    const input = 'x'.repeat(1201);
    const out = formatErrorForUi(input, { maxChars: 10 });
    expect(out.startsWith('x'.repeat(1000))).toBe(true);
    expect(out).toContain('…[truncated]');
  });
});
