import { parseSetupPairingPromptData } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { createSetupThisComputerKind } from '../systemTasks/kinds/setupThisComputer.js';
import { createDefaultInteractiveKinds, runHsetupCli } from './hsetup.js';

describe('runHsetupCli (interactive system tasks)', () => {
  it('streams prompt events and resumes execution when a prompt answer is provided over stdin', async () => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stdinLines: string[] = [
      JSON.stringify({
        protocolVersion: 1,
        kind: 'test.prompt.v1',
        params: {},
      }),
      JSON.stringify({ trusted: true }),
    ];

    const exitCode = await runHsetupCli(['system-tasks', 'run'], {
      stdin: {
        async readAll() {
          return stdinLines.join('\n');
        },
        async readLine() {
          return stdinLines.shift() ?? null;
        },
      },
      stdout: {
        write(chunk) {
          stdoutChunks.push(chunk);
        },
      },
      stderr: {
        write(chunk) {
          stderrChunks.push(chunk);
        },
      },
      now: (() => {
        let ts = 1000;
        return () => ts++;
      })(),
      taskIdFactory: () => 'task-1',
      interactiveKinds: {
        'test.prompt.v1': {
          async run(ctx) {
            ctx.emit({ type: 'progress', stepId: 'prepare', message: 'Preparing' });
            const answer = await ctx.prompt({
              kind: 'ssh.trustHost',
              stepId: 'ssh.hostTrust',
              message: 'Trust this host?',
              data: { host: 'example.test', fingerprint: 'SHA256:abc' },
            }) as { trusted?: boolean };
            ctx.emit({ type: 'progress', stepId: 'finish', message: `Trusted=${answer.trusted}` });
            return { done: true };
          },
        },
      },
    });

    expect(stderrChunks.join('')).toBe('');
    expect(exitCode).toBe(0);

    const lines = stdoutChunks
      .join('')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as any);

    expect(lines[0]).toMatchObject({
      taskId: 'task-1',
      type: 'progress',
      stepId: 'prepare',
    });
    expect(lines[1]).toMatchObject({
      taskId: 'task-1',
      type: 'prompt',
      stepId: 'ssh.hostTrust',
    });
    expect(lines[2]).toMatchObject({
      taskId: 'task-1',
      type: 'progress',
      stepId: 'finish',
    });
    expect(lines[3]).toMatchObject({
      taskId: 'task-1',
      ok: true,
    });
  });

  it('dispatches setup.thisComputer.v1 through the interactive path so the app can answer its pairing prompt over stdin', async () => {
    const stdoutChunks: string[] = [];
    const stdinLines: string[] = [
      JSON.stringify({
        protocolVersion: 1,
        kind: 'setup.thisComputer.v1',
        params: {
          activeRelayUrl: 'https://relay.example.test',
          activeWebappUrl: 'https://app.example.test',
          activeLocalRelayUrl: null,
          channel: 'stable',
          expectedAccountId: 'acct_app',
          surface: 'desktop.ui',
        },
      }),
      JSON.stringify({ approved: true }),
    ];
    const calls: string[] = [];
    const setupKind = createSetupThisComputerKind({
      inspectCliChoice: async () => ({ choice: null, question: null }),
      recordCliChoice: async () => {
        calls.push('recordCliChoice');
      },
      removePathExposure: async () => ({ removed: false, failure: null }),
      ensureCli: async () => ({ command: '/managed/happier', provenance: 'managed', version: '0.2.13' }),
      previewServiceInstall: async () => ({ takeover: null, installConflict: null }),
      readDaemonStatus: async () => ({ serviceInstalled: false, daemonRunning: false, serverComparableKey: null }),
      configureRelay: async (_ring, profile) => ({ serverUrl: profile.serverUrl, comparableKey: 'relay.example.test' }),
      registerRelayProfile: async () => ({ id: 'relay-profile' }),
      readPinnedServiceInventory: async () => ({ listed: true, coexistence: true, relayUrls: [] }),
      readAuthStatus: async () => ({ authenticated: false, accountId: null, machineId: null }),
      requestAuthPairing: async () => ({
        publicKey: 'cHVibGljLWtleQ==',
        publicKeyB64Url: 'cHVibGljLWtleQ',
        pairingRequirement: 'compatible',
      }),
      waitForAuthPairing: async () => {
        calls.push('waitForAuthPairing');
        return { machineId: 'machine-1' };
      },
      installService: async () => {
        calls.push('installService');
      },
      startService: async () => {
        calls.push('startService');
      },
      ensurePathExposure: async () => ({ changed: false, shellReloadHint: null, failure: null }),
    });

    expect(Object.keys(createDefaultInteractiveKinds())).toContain('setup.thisComputer.v1');

    const exitCode = await runHsetupCli(['system-tasks', 'run'], {
      stdin: {
        async readAll() {
          return stdinLines.join('\n');
        },
        async readLine() {
          return stdinLines.shift() ?? null;
        },
      },
      stdout: {
        write(chunk) {
          stdoutChunks.push(chunk);
        },
      },
      stderr: {
        write() {},
      },
      now: () => 1000,
      taskIdFactory: () => 'task-setup',
      interactiveKinds: { ...createDefaultInteractiveKinds(), 'setup.thisComputer.v1': setupKind },
    });

    expect(exitCode).toBe(0);
    // stdout is an untyped process boundary; every field is validated below.
    const lines = stdoutChunks.join('').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const prompt = lines.find((line) => line.type === 'prompt');
    if (!prompt) throw new Error('hsetup emitted no prompt event');
    expect(prompt).toMatchObject({ taskId: 'task-setup', stepId: 'setup.thisComputer.auth.request' });
    // The bytes the desktop app receives must parse through the shared prompt contract; this is
    // the only proof that producer and reader still agree across the package boundary.
    expect(parseSetupPairingPromptData(prompt.data)).toEqual({
      publicKeyB64Url: 'cHVibGljLWtleQ',
      relayUrl: 'https://relay.example.test',
      serverIdentityKey: 'relay.example.test',
      accountId: 'acct_app',
      pairingRequirement: 'compatible',
      cliProvenance: 'managed',
      // The exact command `ensureCli` resolved, so the human confirmation names the binary that is
      // really asking rather than a generic "the CLI".
      cliCommand: '/managed/happier',
    });
    expect(JSON.stringify(lines)).not.toMatch(/secret|token|password|statefile/i);
    expect(calls).toEqual(['waitForAuthPairing', 'installService', 'startService']);
    expect(lines.at(-1)).toMatchObject({ taskId: 'task-setup', ok: true, data: { machineId: 'machine-1', serviceAction: 'install' } });
  });
});
