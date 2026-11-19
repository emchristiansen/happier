import { describe, expect, it, vi } from 'vitest';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const steer = vi.hoisted(() => vi.fn());
vi.mock('@/session/services/steerSessionAtToolBoundary', () => ({ steerSessionAtToolBoundary: steer }));

const credentials = { token: 'test', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };

describe('session steer ingress', () => {
  it('passes an attributable message to the no-resume steering service', async () => {
    const { cmdSessionSteer } = await import('./steer');
    steer.mockResolvedValueOnce({ ok: true, sessionId: 's', result: 'written_to_hook_response' });
    const output = captureConsoleJsonOutput();
    try {
      await cmdSessionSteer(['steer', 's', 'hello', '--from', 'worker/123', '--wait-ms', '100', '--json'], { readCredentialsFn: async () => credentials });
      expect(steer).toHaveBeenLastCalledWith({ credentials, idOrPrefix: 's', message: '[Steering from worker/123 (caller-asserted)]\nhello', waitMs: 100 });
      expect(output.json()).toMatchObject({ ok: true, kind: 'session_steer', data: { result: 'written_to_hook_response' } });
    } finally { output.restore(); }
  });
  it('rejects surplus positionals and unknown options before reading credentials', async () => {
    const { cmdSessionSteer } = await import('./steer');
    const readCredentialsFn = vi.fn(async () => credentials);
    for (const argv of [
      ['steer', 's', 'first', 'DO NOT DEPLOY', '--from', 'worker', '--wait-ms', '100'],
      ['steer', '--frmo', 'wrong-target', 's', 'message', '--from', 'worker', '--wait-ms', '100'],
      ['steer', 's', 'message', '--from', 'worker', '--from', 'other', '--wait-ms', '100'],
      ['steer', 's', 'message', '--from', '--wait-ms', '100'],
    ]) {
      await expect(cmdSessionSteer(argv, { readCredentialsFn })).rejects.toMatchObject({ code: 'invalid_arguments' });
    }
    expect(readCredentialsFn).not.toHaveBeenCalled();
  });
  it('allows a dash-leading message after the option terminator', async () => {
    const { cmdSessionSteer } = await import('./steer');
    steer.mockResolvedValueOnce({ ok: true, sessionId: 's', result: 'written_to_hook_response' });
    const output = captureConsoleJsonOutput();
    try {
      await cmdSessionSteer(['steer', 's', '--from', 'worker', '--wait-ms', '100', '--json', '--', '--do not deploy'], { readCredentialsFn: async () => credentials });
      expect(steer).toHaveBeenLastCalledWith({ credentials, idOrPrefix: 's', message: '[Steering from worker (caller-asserted)]\n--do not deploy', waitMs: 100 });
    } finally { output.restore(); }
  });
  it('rejects missing or multiline attribution before reading credentials', async () => {
    const { cmdSessionSteer } = await import('./steer');
    const readCredentialsFn = vi.fn(async () => credentials);
    for (const sender of ['', 'x\ny']) {
      await expect(cmdSessionSteer(['steer', 's', 'hello', '--from', sender, '--wait-ms', '100'], { readCredentialsFn })).rejects.toMatchObject({ code: 'invalid_arguments' });
    }
    expect(readCredentialsFn).not.toHaveBeenCalled();
  });
  it('reports an uncertain delivery without claiming success or using send fallback', async () => {
    const { cmdSessionSteer } = await import('./steer');
    steer.mockResolvedValueOnce({ ok: false, sessionId: 's', code: 'delivery_uncertain' });
    const output = captureConsoleJsonOutput();
    try {
      await cmdSessionSteer(['steer', 's', 'hello', '--from', 'worker/123', '--wait-ms', '100', '--json'], { readCredentialsFn: async () => credentials });
      expect(output.json()).toMatchObject({ ok: false, error: { code: 'delivery_uncertain' } });
    } finally { output.restore(); process.exitCode = 0; }
  });
});
