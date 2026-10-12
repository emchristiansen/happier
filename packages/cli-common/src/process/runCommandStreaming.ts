import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { resolveWindowsCommandInvocation } from './windows/resolveWindowsCommandInvocation.js';

function appendTail(current: string, chunk: string, maxBytes: number): string {
  const combined = current + chunk;
  if (Buffer.byteLength(combined, 'utf8') <= maxBytes) {
    return combined;
  }

  let trimmed = combined;
  while (Buffer.byteLength(trimmed, 'utf8') > maxBytes) {
    trimmed = trimmed.slice(Math.max(1, Math.floor(trimmed.length / 8)));
  }
  return trimmed;
}

function formatTail(label: string, value: string): string {
  const trimmed = value.trim();
  return trimmed ? `\n${label}:\n${trimmed}` : '';
}

export type CommandCaptureResult =
  | Readonly<{ kind: 'exited'; status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>
  | Readonly<{ kind: 'timed-out'; timeoutMs: number; stdout: string; stderr: string }>
  | Readonly<{ kind: 'aborted'; error: unknown }>
  | Readonly<{ kind: 'spawn-failed'; message: string; error: unknown }>;

/**
 * The process owner's single spawn-and-capture implementation. Runs a command
 * without blocking the event loop and resolves with its outcome (never rejects).
 * `timeoutMs > 0` sends SIGTERM after that long and settles `timed-out` at once
 * with the output so far; `maxCapturedBytes` keeps only the output tail, otherwise
 * output is kept whole. An aborted signal sends SIGTERM and settles `aborted`;
 * cancellation stops this command, not any already-applied external service changes.
 */
export async function runCommandCapture(params: Readonly<{
  cmd: string;
  args: ReadonlyArray<string>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxCapturedBytes?: number;
  resolveCommandOnPath?: boolean;
  /** Defaults to true (no console window for the child on Windows). */
  windowsHide?: boolean;
}>): Promise<CommandCaptureResult> {
  const abortError = () => params.signal?.reason ?? new DOMException('This operation was aborted', 'AbortError');
  if (params.signal?.aborted) return { kind: 'aborted', error: abortError() };
  const cmd = String(params.cmd ?? '').trim();
  if (!cmd) {
    return { kind: 'spawn-failed', message: 'command is required', error: new Error('command is required') };
  }

  const invocation = resolveWindowsCommandInvocation({
    command: cmd,
    args: params.args,
    env: params.env,
    ...(params.resolveCommandOnPath !== undefined ? { resolveCommandOnPath: params.resolveCommandOnPath } : {}),
  });
  const append = (current: string, chunk: string): string =>
    params.maxCapturedBytes === undefined ? current + chunk : appendTail(current, chunk, params.maxCapturedBytes);
  const timeoutMs = Math.max(0, Math.floor(params.timeoutMs ?? 0));

  return await new Promise<CommandCaptureResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(invocation.command, [...invocation.args], {
        cwd: params.cwd,
        env: params.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: params.windowsHide !== false,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
    } catch (error) {
      resolve({ kind: 'spawn-failed', message: error instanceof Error ? error.message : String(error), error });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          child.kill('SIGTERM');
          settle({ kind: 'timed-out', timeoutMs, stdout, stderr });
        }, timeoutMs)
      : null;
    const settle = (result: CommandCaptureResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      params.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => {
      if (settled) return;
      child.kill('SIGTERM');
      settle({ kind: 'aborted', error: abortError() });
    };
    params.signal?.addEventListener('abort', onAbort, { once: true });
    if (params.signal?.aborted) onAbort();

    // Decode per stream so a multi-byte character split across chunks stays intact.
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const decode = (decoder: StringDecoder, chunk: Buffer | string): string =>
      typeof chunk === 'string' ? chunk : decoder.write(chunk);
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout = append(stdout, decode(stdoutDecoder, chunk));
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = append(stderr, decode(stderrDecoder, chunk));
    });
    child.once('error', (error) => {
      settle({ kind: 'spawn-failed', message: String(error.message || error), error });
    });
    child.once('close', (code, signal) => {
      stdout = append(stdout, stdoutDecoder.end());
      stderr = append(stderr, stderrDecoder.end());
      settle({ kind: 'exited', status: code, signal, stdout, stderr });
    });
  });
}

export async function runCommandStreaming(params: Readonly<{
  cmd: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  context?: string;
  maxCapturedBytes?: number;
}>): Promise<void> {
  const cmd = String(params.cmd ?? '').trim();
  if (!cmd) {
    throw new Error('command is required');
  }

  const result = await runCommandCapture({
    cmd,
    args: params.args,
    cwd: params.cwd,
    env: params.env,
    maxCapturedBytes: Math.max(4 * 1024, Number(params.maxCapturedBytes ?? 32 * 1024)),
  });
  const context = params.context ? `[${params.context}] ` : '';
  if (result.kind === 'aborted') throw result.error;
  if (result.kind === 'spawn-failed') {
    throw new Error(`${context}failed to start ${cmd}: ${result.message}`);
  }
  if (result.kind === 'exited' && result.status === 0) return;

  const status = result.kind === 'exited' ? result.status : null;
  const signalSuffix = result.kind === 'exited' && result.signal ? ` (signal ${result.signal})` : '';
  throw new Error(
    `${context}${cmd} exited with status ${status ?? 'unknown'}${signalSuffix}`
    + formatTail('stderr', result.stderr)
    + formatTail('stdout', result.stdout),
  );
}
