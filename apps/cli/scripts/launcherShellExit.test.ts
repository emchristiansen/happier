import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { isPidAlive, spawnInlineNodeTestProcess, spawnTestProcess, waitForProcessExit } from '@/testkit/process/spawn';

it.skipIf(process.platform === 'win32').each(['claude-cmd', 'claude-forced', 'terminal', 'claude-native', 'terminal-native'] as const)(
  'qualifies the real %s exit without waiting for surviving descendants', async kind => {
    // POSIX executable fixtures exercise the real process/IPC/pipe boundaries while the
    // Claude invocation builder takes its Windows ComSpec branch in an isolated child.
    const direct = kind.endsWith('-native');
    const terminal = kind.startsWith('terminal');
    const directory = await mkdtemp(join(tmpdir(), 'happier-launcher-shell-exit-'));
    const pidPath = join(directory, 'provider.pid');
    const shell = join(directory, 'cmd.exe');
    const providerSource = 'process.send("ready"); setInterval(() => {}, 1000);';
    await writeFile(shell, direct ? `#!${process.execPath}\nprocess.exit(0);` : `#!${process.execPath}\n
      const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(providerSource)}],
        { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
      child.once('message', () => process.exit(0));
    `, { mode: 0o700 });
    const runtime = resolve(__dirname, 'claude_launcher_runtime.cjs');
    const runner = resolve(__dirname, 'terminal_launch_spec_runner.cjs');
    const specPath = join(directory, 'launch.json');
    await writeFile(specPath, JSON.stringify({ command: shell, args: [], cwd: directory, env: {},
      windowsVerbatimArguments: !direct }));
    const source = `Object.defineProperty(process, 'platform', {value:'win32'});
      process.env.ComSpec = ${JSON.stringify(shell)};
      process.env.HAPPIER_WINDOWS_CLAUDE_SPAWN_VIA_CMDSPEC = ${JSON.stringify(kind === 'claude-forced' ? '1' : '0')};
      require(${JSON.stringify(runtime)}).runClaudeCli(${JSON.stringify(direct ? shell : join(directory, kind === 'claude-cmd' ? 'claude.cmd' : 'claude.exe'))});`;
    // The terminal runner enables its controller channel only as a genuine executable entry point.
    const child = terminal
      ? spawnTestProcess(process.execPath, [runner, specPath], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      : spawnInlineNodeTestProcess(source, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const channelClosed = child.connected ? once(child, 'disconnect') : Promise.resolve();
    const messages: unknown[] = [];
    child.on('message', message => messages.push(message));
    let providerPid: number | undefined;
    try {
      if (!direct) await vi.waitFor(async () => { providerPid = Number(await readFile(pidPath, 'utf8')); expect(providerPid).toBeGreaterThan(0); });
      await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 3_000 });
      await channelClosed;
      if (direct) expect(messages).toContainEqual({ type: 'terminal-native-exited', code: 0, signal: null });
      else {
        expect(isPidAlive(providerPid!)).toBe(true);
        expect(messages).not.toContainEqual(expect.objectContaining({ type: 'terminal-native-exited' }));
      }
    } finally {
      if (!direct && providerPid === undefined) providerPid = await readFile(pidPath, 'utf8').then(Number, () => undefined);
      if (providerPid) { process.kill(providerPid, 'SIGKILL'); await waitForProcessExit(providerPid); }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000,
);
