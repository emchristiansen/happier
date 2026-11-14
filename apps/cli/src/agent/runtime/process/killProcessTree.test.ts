import { describe, it, expect, vi } from 'vitest';
import { once } from 'node:events';
import fs, { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import psList from 'ps-list';
import { withTempDir } from '@/testkit/fs/tempDir';

// Process enumeration is an OS boundary; preserve the real listing outside the controlled discovery race.
vi.mock('ps-list', async importOriginal => {
  const actual = await importOriginal<typeof import('ps-list')>();
  return { ...actual, default: vi.fn(actual.default) };
});

import { isPidAlive, spawnInlineNodeParentWithChild, spawnInlineNodeTestProcess, waitForProcessExit } from '@/testkit/process/spawn';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
// The shared CJS owner accepts an injected enumeration boundary.
import { killProcessTree as terminate, killProcessTreeGuarded as terminateGuarded } from '../../../../scripts/process_tree.cjs';
import { logger } from '@/ui/logger';

describe('killProcessTree', () => {
  it.runIf(process.platform !== 'win32').each(['lost', 'captured'] as const)('does not signal an exited root while cleaning %s descendants discovered across its exit', async discovery => {
    await withTempDir('process-tree-discovery-exit-', async directory => {
      const ackPath = join(directory, 'provider-alive');
      const { parent, childPid } = await spawnInlineNodeParentWithChild(`
        process.on('SIGUSR2', () => require('node:fs').writeFileSync(${JSON.stringify(ackPath)}, 'alive'));
        setInterval(() => {}, 1000);
      `);
      const enumerate = vi.mocked(psList).getMockImplementation();
      if (!enumerate) throw new Error('Expected the real process enumeration boundary');
      vi.mocked(psList).mockImplementationOnce(async () => {
        const captured = discovery === 'captured' ? await enumerate() : undefined;
        const exited = once(parent, 'exit');
        parent.kill('SIGKILL');
        await exited;
        return captured ?? await enumerate();
      });
      const signal = process.kill.bind(process);
      const postExitRootSignals: unknown[] = [];
      // A numeric PID can be reused after this real child exits; never signal its replacement.
      const recycled = vi.spyOn(process, 'kill').mockImplementation((pid, requestedSignal) => {
        if (pid === parent.pid && (parent.exitCode !== null || parent.signalCode !== null)) {
          postExitRootSignals.push(requestedSignal);
          return true;
        }
        return signal(pid, requestedSignal);
      });
      try {
        const result = await killProcessTree(parent, { graceMs: 25 });
        if (discovery === 'lost') {
          process.kill(childPid, 'SIGUSR2');
          await vi.waitFor(async () => expect(await readFile(ackPath, 'utf8')).toBe('alive'));
        } else {
          await expect(waitForProcessExit(childPid, { timeoutMs: 3_000 })).resolves.toBe(true);
        }
        expect(postExitRootSignals).toEqual([]);
        expect(result).toEqual({ rootObservedAlive: false, coverage: 'snapshot' });
      } finally {
        recycled.mockRestore();
        vi.mocked(psList).mockImplementation(enumerate);
        parent.kill('SIGKILL');
        await killProcessTree({ pid: childPid }, { graceMs: 25 });
      }
    });
  });

  it('does not mistake a closed owned child for an executing process when its PID remains signalable', async () => {
    const child = spawnInlineNodeTestProcess('process.exit(0)');
    await once(child, 'close');
    const signal = process.kill.bind(process);
    // Genuine OS boundary vector: a reused numeric PID remains signalable after its owned child closes.
    const defunct = vi.spyOn(process, 'kill').mockImplementation((pid, requestedSignal) => (
      pid === child.pid ? true : signal(pid, requestedSignal)
    ));
    vi.mocked(psList).mockClear();
    try {
      await expect(killProcessTree(child, { graceMs: 25 })).resolves.toEqual({ rootObservedAlive: false, coverage: 'snapshot' });
      expect(psList).not.toHaveBeenCalled();
      expect(defunct).not.toHaveBeenCalled();
    } finally {
      defunct.mockRestore();
    }
  });

  it.runIf(process.platform !== 'win32')('does not probe or escalate against a root that exits during grace', async () => {
    const child = spawnInlineNodeTestProcess('setInterval(() => {}, 1000)');
    const signal = process.kill.bind(process);
    const postExitRootSignals: unknown[] = [];
    const recycled = vi.spyOn(process, 'kill').mockImplementation((pid, requestedSignal) => {
      if (pid === child.pid && (child.exitCode !== null || child.signalCode !== null)) {
        postExitRootSignals.push(requestedSignal);
        return true;
      }
      return signal(pid, requestedSignal);
    });
    try {
      await expect(killProcessTree(child, { graceMs: 25 })).resolves.toEqual({ rootObservedAlive: true, coverage: 'snapshot' });
      expect(child.signalCode).toBe('SIGTERM');
      expect(postExitRootSignals).toEqual([]);
    } finally {
      recycled.mockRestore();
      child.kill('SIGKILL');
      await waitForProcessExit(child.pid!, { timeoutMs: 3_000 });
    }
  });

  it.each(['probe', 'signal', 'both'] as const)('records %s failures separately when the OS denies access to the known root', async failure => {
    const child = spawnInlineNodeTestProcess('setInterval(() => {}, 1000)');
    const signal = process.kill.bind(process);
    logger.flushSync();
    const before = existsSync(logger.getLogPath()) ? readFileSync(logger.getLogPath(), 'utf8') : '';
    // Genuine OS signal/probe denial, restricted to this test's real owned root.
    const denied = vi.spyOn(process, 'kill').mockImplementation((pid, requestedSignal) => {
      if (pid === child.pid && (failure === 'both' || (requestedSignal === 0 ? failure === 'probe' : failure === 'signal'))) {
        throw Object.assign(new Error('private-native-value'), { code: 'EPERM' });
      }
      return signal(pid, requestedSignal);
    });
    try {
      await expect(killProcessTree(child, { graceMs: 25 })).rejects.toMatchObject({
        code: 'process_tree_termination_incomplete',
        discoveryFailed: false,
        probeFailed: failure !== 'signal',
        signallingFailed: failure !== 'probe',
      });
      logger.flushSync();
      const diagnostic = readFileSync(logger.getLogPath(), 'utf8').slice(before.length);
      expect(diagnostic).toMatch(/"discoveryFailed":\s*false/);
      expect(diagnostic).toMatch(new RegExp(`"probeFailed":\\s*${failure !== 'signal'}`));
      expect(diagnostic).toMatch(new RegExp(`"signallingFailed":\\s*${failure !== 'probe'}`));
      expect(diagnostic).not.toContain('private-native-value');
    } finally {
      denied.mockRestore();
      child.kill('SIGKILL');
      await waitForProcessExit(child.pid!, { timeoutMs: 3_000 });
    }
  });

  it.runIf(process.platform === 'linux')('never suspends the root or takes over termination signals while discovery is pending', async () => {
    const root = spawnInlineNodeTestProcess('setInterval(() => {}, 1000)', { detached: true });
    const listenersBefore = ['SIGTERM', 'SIGINT', 'SIGHUP'].map((signal) => process.listenerCount(signal));
    let releaseDiscovery!: () => void;
    const discoveryReleased = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
    try {
      const cleanup = terminate(root, { graceMs: 1_000 }, async () => { await discoveryReleased; return []; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Process state is the third field of /proc/<pid>/stat: T/t would mean stopped or traced.
      const stat = readFileSync(`/proc/${root.pid}/stat`, 'utf8');
      expect(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]).not.toMatch(/^[Tt]$/);
      expect(['SIGTERM', 'SIGINT', 'SIGHUP'].map((signal) => process.listenerCount(signal))).toEqual(listenersBefore);
      releaseDiscovery();
      await expect(cleanup).resolves.toEqual({ rootObservedAlive: true, coverage: 'snapshot' });
      await expect(waitForProcessExit(root.pid!, { timeoutMs: 3_000 })).resolves.toBe(true);
    } finally {
      releaseDiscovery();
      root.kill('SIGKILL');
    }
  });

  it.runIf(process.platform === 'linux')('reaches a process-group root\'s child that no snapshot listed', async () => {
    // A detached root leads its own process group, and its child inherits that group.
    const root = spawnInlineNodeTestProcess(`
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      console.log(String(child.pid));
      setInterval(() => {}, 1000);
    `, { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    const [output] = await once(root.stdout!, 'data');
    const childPid = Number(String(output).trim());
    try {
      // The child exists but every snapshot misses it, as a freshly spawned process can be. This
      // owner spawned the root detached, so it declares the root's process group as owned.
      await expect(terminate(root, { graceMs: 1_000, processGroup: 'owned' }, async () => []))
        .resolves.toEqual({ rootObservedAlive: true, coverage: 'process_group' });
      await expect(waitForProcessExit(root.pid!, { timeoutMs: 3_000 })).resolves.toBe(true);
      await expect(waitForProcessExit(childPid, { timeoutMs: 3_000 })).resolves.toBe(true);
    } finally {
      root.kill('SIGKILL');
      try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  it.runIf(process.platform === 'linux')('completes a guarded cleanup of a real owned group, and refuses an undeclared one untouched', async () => {
    const spawnRootWithChild = async () => {
      const root = spawnInlineNodeTestProcess(`
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        console.log(String(child.pid));
        setInterval(() => {}, 1000);
      `, { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
      const [output] = await once(root.stdout!, 'data');
      return { root, childPid: Number(String(output).trim()) };
    };
    const owned = await spawnRootWithChild();
    const undeclared = await spawnRootWithChild();
    try {
      const sameWhileRunning = (child: typeof owned.root) => () => (child.exitCode === null && child.signalCode === null ? 'same' as const : 'not_same' as const);
      // Every snapshot misses the child; only the owned group reaches it.
      await expect(terminateGuarded(owned.root, {
        graceMs: 1_000, processGroup: 'owned', readRootIdentity: sameWhileRunning(owned.root),
      }, async () => [])).resolves.toBe('completed');
      await expect(waitForProcessExit(owned.root.pid!, { timeoutMs: 3_000 })).resolves.toBe(true);
      await expect(waitForProcessExit(owned.childPid, { timeoutMs: 3_000 })).resolves.toBe(true);

      await expect(terminateGuarded(undeclared.root, {
        graceMs: 1_000, readRootIdentity: sameWhileRunning(undeclared.root),
      }, async () => [])).resolves.toBe('snapshot_only');
      expect(isPidAlive(undeclared.root.pid!)).toBe(true);
      expect(isPidAlive(undeclared.childPid)).toBe(true);
    } finally {
      for (const { root, childPid } of [owned, undeclared]) {
        root.kill('SIGKILL');
        try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ }
        await waitForProcessExit(childPid, { timeoutMs: 3_000 });
      }
    }
  });

  it.runIf(process.platform === 'linux').each(['guarded', 'unguarded'] as const)('reports a %s cleanup incomplete when the root exits leaving a group member it forked on SIGTERM', async mode => {
    await withTempDir('process-tree-late-fork-', async directory => {
      const childPidPath = join(directory, 'late-child-pid');
      const ackPath = join(directory, 'late-child-alive');
      // The detached root leads its own group. Its SIGTERM handler forks a child into that group after
      // every snapshot, waits until the child is running, then exits normally.
      const root = spawnInlineNodeTestProcess(`
        const { spawn } = require('node:child_process');
        const fs = require('node:fs');
        process.on('SIGTERM', () => {
          const child = spawn(process.execPath, ['-e', ${JSON.stringify(`
            process.on('SIGUSR2', () => require('node:fs').writeFileSync(${JSON.stringify(ackPath)}, String(process.pid)));
            setInterval(() => {}, 1000);
          `)}], { stdio: 'ignore' });
          child.on('spawn', () => {
            fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
            setTimeout(() => process.exit(0), 50);
          });
        });
        console.log('ready');
        setInterval(() => {}, 1000);
      `, { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
      await once(root.stdout!, 'data');
      let childPid: number | null = null;
      try {
        // The real process listing; the root's ordinary exit must not be read as whole-tree cleanup.
        const cleanup = mode === 'guarded'
          ? terminateGuarded(root, {
            graceMs: 1_000,
            processGroup: 'owned',
            readRootIdentity: () => (root.exitCode === null && root.signalCode === null ? 'same' : 'not_same'),
          })
          : terminate(root, { graceMs: 1_000, processGroup: 'owned' });
        await expect(cleanup).rejects.toMatchObject({ code: 'process_tree_termination_incomplete', groupMembersRemained: true });
        expect(root.exitCode).toBe(0);
        childPid = Number(await readFile(childPidPath, 'utf8'));
        // The member is executing, not a defunct entry: it answers a fresh signal.
        process.kill(childPid, 'SIGUSR2');
        await vi.waitFor(async () => expect(await readFile(ackPath, 'utf8')).toBe(String(childPid)));
      } finally {
        root.kill('SIGKILL');
        childPid ??= existsSync(childPidPath) ? Number(readFileSync(childPidPath, 'utf8')) : null;
        if (childPid) {
          try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ }
          await waitForProcessExit(childPid, { timeoutMs: 3_000 });
        }
      }
    });
  });

  it.runIf(process.platform === 'linux')('sends a guarded root nothing, and never reports completion, when its group cannot be read at a signal', async () => {
    const root = spawnInlineNodeTestProcess(`
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      console.log(String(child.pid));
      setInterval(() => {}, 1000);
    `, { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    const [output] = await once(root.stdout!, 'data');
    const childPid = Number(String(output).trim());
    const statPath = `/proc/${root.pid}/stat`;
    const readFileSyncActual = fs.readFileSync;
    let groupReads = 0;
    // The group validates before and after discovery; the first read at each root signal then fails
    // transiently and the next one succeeds. One failed observation must decide that signal.
    const transient = vi.spyOn(fs, 'readFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, options?: unknown) => {
      if (path === statPath) {
        groupReads += 1;
        if (groupReads >= 3 && groupReads % 2 === 1) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      }
      return (readFileSyncActual as (p: fs.PathOrFileDescriptor, o?: unknown) => string | Buffer)(path, options);
    }) as typeof fs.readFileSync);
    const signalActual = process.kill.bind(process);
    const sent: Array<readonly [number, NodeJS.Signals | number | undefined]> = [];
    const signals = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal !== 0) sent.push([pid, signal]);
      return signalActual(pid, signal);
    }) as typeof process.kill);
    try {
      await expect(terminateGuarded(root, {
        graceMs: 50,
        processGroup: 'owned',
        readRootIdentity: () => (root.exitCode === null && root.signalCode === null ? 'same' : 'not_same'),
      }, async () => [])).resolves.toBe('snapshot_only');
      expect(sent).toEqual([]);
      expect(isPidAlive(root.pid!)).toBe(true);
      expect(isPidAlive(childPid)).toBe(true);
    } finally {
      transient.mockRestore();
      signals.mockRestore();
      root.kill('SIGKILL');
      try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ }
      await waitForProcessExit(childPid, { timeoutMs: 3_000 });
    }
  });

  it.runIf(process.platform === 'linux')('reports snapshot coverage, not a group, for an undeclared group-leader root', async () => {
    const root = spawnInlineNodeTestProcess(`
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      console.log(String(child.pid));
      setInterval(() => {}, 1000);
    `, { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    const [output] = await once(root.stdout!, 'data');
    const childPid = Number(String(output).trim());
    try {
      // Leading its own group is not ownership: without the spawning owner's declaration only the
      // root PID is signalled, so the child no snapshot listed survives and coverage says so.
      await expect(terminate(root, { graceMs: 1_000 }, async () => []))
        .resolves.toEqual({ rootObservedAlive: true, coverage: 'snapshot' });
      await expect(waitForProcessExit(root.pid!, { timeoutMs: 3_000 })).resolves.toBe(true);
      expect(isPidAlive(childPid)).toBe(true);
    } finally {
      root.kill('SIGKILL');
      try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ }
      await waitForProcessExit(childPid, { timeoutMs: 3_000 });
    }
  });

  it('kills a process and its descendants (posix)', async () => {
    if (process.platform === 'win32') return;

    const { parent, childPid } = await spawnInlineNodeParentWithChild();

    expect(parent.pid).toBeTruthy();
    expect(childPid).toBeGreaterThan(0);
    expect(isPidAlive(parent.pid!)).toBe(true);
    expect(isPidAlive(childPid)).toBe(true);

    await expect(killProcessTree(parent, { graceMs: 250 })).resolves.toEqual({ rootObservedAlive: true, coverage: 'snapshot' });

    await expect(waitForProcessExit(parent.pid!, { timeoutMs: 10_000 })).resolves.toBe(true);
    await expect(waitForProcessExit(childPid, { timeoutMs: 10_000 })).resolves.toBe(true);
  }, 30_000);
});
