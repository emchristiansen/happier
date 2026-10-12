import { describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const execute = vi.fn();
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute }));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

describe('happier session send (action executor)', () => {
  it('treats --local-id after the option terminator as the literal message', async () => {
    const readCredentialsFn = vi.fn(async () => null);
    const { handleSessionCommand } = await import('./handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['send', '--json', 'sess-1', '--', '--local-id'], { readCredentialsFn });
      expect(readCredentialsFn).toHaveBeenCalledOnce();
      expect(output.json()).toMatchObject({ ok: false, error: { code: 'not_authenticated' } });
    } finally {
      output.restore();
    }
  });

  it('rejects a malformed timeout before reading credentials', async () => {
    const readCredentialsFn = vi.fn(async () => null);
    const { cmdSessionSend } = await import('./send');
    await expect(cmdSessionSend(['send', 'sess-1', 'Hello', '--timeout', '10oops'], { readCredentialsFn }))
      .rejects.toMatchObject({ code: 'invalid_arguments' });

    expect(readCredentialsFn).not.toHaveBeenCalled();
  });

  it('rejects a blank local id before sending', async () => {
    execute.mockClear();
    const readCredentialsFn = vi.fn(async () => null);
    const { cmdSessionSend } = await import('./send');
    await expect(cmdSessionSend(['send', 'sess-1', 'Hello', '--local-id', '  '], { readCredentialsFn }))
      .rejects.toMatchObject({ code: 'invalid_arguments' });
    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['--json', '-claim-1'])('rejects %s as a missing local id value', async (nextFlag) => {
    execute.mockClear();
    const readCredentialsFn = vi.fn(async () => null);
    const { cmdSessionSend } = await import('./send');
    await expect(cmdSessionSend(['send', 'sess-1', 'Hello', '--local-id', nextFlag], { readCredentialsFn }))
      .rejects.toMatchObject({ code: 'invalid_arguments' });
    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['uses the default timeout when --timeout is omitted', ['send', 'sess-1', 'Hello', '--json'], 300],
    ['clamps an explicit timeout to the supported maximum', ['send', 'sess-1', 'Hello', '--timeout', '9999', '--json'], 3600],
  ])('%s', async (_label, argv, expectedTimeoutSeconds) => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, sessionId: 'sess-1', localId: 'local-1', waited: false },
    });
    const { cmdSessionSend } = await import('./send');

    const output = captureConsoleJsonOutput();
    try {
      await cmdSessionSend(argv, {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(execute).toHaveBeenLastCalledWith(
        'session.message.send',
        expect.objectContaining({ timeoutSeconds: expectedTimeoutSeconds }),
        { surface: 'cli', defaultSessionId: null },
      );
    } finally {
      output.restore();
    }
  });

  it('prints approval_request_created as the JSON envelope data', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-1' },
    });

    const { handleSessionCommand } = await import('./handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['send', 'sess-1', 'Hello', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_send',
        data: { kind: 'approval_request_created', artifactId: 'approval-1' },
      }));
    } finally {
      output.restore();
    }
  });
});
