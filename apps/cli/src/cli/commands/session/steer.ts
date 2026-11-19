import type { Credentials } from '@/persistence';
import { argvBeforeOptionTerminator, readCommandPositionals, readFlagValue, readIntFlagValue } from '@/cli/commands/shared/argvFlags';
import { printJsonEnvelope, wantsJson } from '@/cli/output/jsonEnvelope';
import { steerSessionAtToolBoundary } from '@/session/services/steerSessionAtToolBoundary';

export const SESSION_STEER_USAGE = 'happier session steer <session-id-or-prefix-or-tag> <message> --from <sender> --wait-ms <milliseconds> [--json]';

/** Sender is asserted by the caller, not authenticated by the steering protocol. */
export async function cmdSessionSteer(argv: string[], deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>): Promise<void> {
  const options = argvBeforeOptionTerminator(argv);
  const json = wantsJson(options);
  const positionals = readCommandPositionals(argv, { startIndex: 1, valueFlags: ['--from', '--wait-ms'] });
  const seen = new Set<string>();
  for (let index = 1; index < options.length; index += 1) {
    const arg = options[index];
    if (!arg.startsWith('-')) continue;
    if (!['--from', '--wait-ms', '--json'].includes(arg) || seen.has(arg)) {
      throw Object.assign(new Error(`Usage: ${SESSION_STEER_USAGE}`), { code: 'invalid_arguments' });
    }
    seen.add(arg);
    if (arg !== '--json') {
      const value = options[++index];
      if (!value || value.startsWith('-')) {
        throw Object.assign(new Error(`Usage: ${SESSION_STEER_USAGE}`), { code: 'invalid_arguments' });
      }
    }
  }
  if (positionals.length !== 2) {
    throw Object.assign(new Error(`Usage: ${SESSION_STEER_USAGE}`), { code: 'invalid_arguments' });
  }
  const [idOrPrefix, message] = positionals;
  const from = readFlagValue(options, '--from');
  const waitMs = readIntFlagValue(options, '--wait-ms', { min: 1 });
  if (!idOrPrefix.trim() || !message.trim() || !from?.trim() || /[\r\n]/.test(from) || from.startsWith('-') || waitMs === null || waitMs === undefined || waitMs > 2_147_483_647) {
    throw Object.assign(new Error(`Usage: ${SESSION_STEER_USAGE}`), { code: 'invalid_arguments' });
  }
  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) { await printJsonEnvelope({ ok: false, kind: 'session_steer', error: { code: 'not_authenticated' } }, { exitCode: 1 }); return; }
    throw Object.assign(new Error('Not authenticated'), { code: 'not_authenticated' });
  }
  const result = await steerSessionAtToolBoundary({ credentials, idOrPrefix, message: `[Steering from ${from.trim()} (caller-asserted)]\n${message}`, waitMs });
  if (!result.ok) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_steer', error: { code: result.code, ...('candidates' in result && result.candidates ? { candidates: result.candidates } : {}) } }, { exitCode: 1 });
      return;
    }
    throw Object.assign(new Error(result.code), { code: result.code });
  }
  if (json) { await printJsonEnvelope({ ok: true, kind: 'session_steer', data: result }); return; }
  console.log(`${result.result}: ${result.sessionId} (provider consumption not confirmed)`);
}
