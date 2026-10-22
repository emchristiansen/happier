import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('startDaemon log-retention wiring', () => {
  it('starts the log-retention loop during startup and stops it in cleanupAndShutdown', async () => {
    const source = await readFile(new URL('./startDaemon.ts', import.meta.url), 'utf8');

    const reattachIndex = source.indexOf('await reattachTrackedSessionsFromMarkers');
    const startIndex = source.indexOf('logRetentionLoopHandle = startLogRetentionLoop(');
    const cleanupIndex = source.indexOf('const cleanupAndShutdown = async');
    const stopIndex = source.indexOf('logRetentionLoopHandle.stop();');
    const exitIndex = source.indexOf("logger.debug('[DAEMON RUN] Cleanup completed, exiting process');");

    expect(reattachIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeGreaterThan(reattachIndex);
    expect(source.indexOf('logRetentionLoopHandle = startLogRetentionLoop(', startIndex + 1)).toBe(-1);
    const startCall = source.slice(startIndex, startIndex + 600);
    expect(startCall).toContain('runDaemonLogRetention({');
    expect(startCall).toContain('logsDir: configuration.logsDir');
    expect(startCall).toContain('currentLogPath: logger.getLogPath()');
    expect(cleanupIndex).toBeGreaterThan(startIndex);
    expect(stopIndex).toBeGreaterThan(cleanupIndex);
    expect(exitIndex).toBeGreaterThan(stopIndex);
  });

  it('reaches startDaemon, and so the retention pass, only from `daemon start-sync` after help is answered', async () => {
    const daemonCommand = await readFile(new URL('../cli/commands/daemon.ts', import.meta.url), 'utf8');
    const startSyncIndex = daemonCommand.indexOf("if (daemonSubcommand === 'start-sync') {");
    const callIndex = daemonCommand.indexOf('await startDaemon(');

    expect(startSyncIndex).toBeGreaterThanOrEqual(0);
    expect(callIndex).toBeGreaterThan(startSyncIndex);
    expect(daemonCommand.indexOf('await startDaemon(', callIndex + 1)).toBe(-1);
    // Help is answered before any subcommand runs.
    expect(daemonCommand.indexOf('if (shouldPrintDaemonHelp(args)) {')).toBeLessThan(startSyncIndex);
  });
});
