import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('startDaemon session-log retention wiring', () => {
  it('starts the session-log retention loop during startup and stops it in cleanupAndShutdown', async () => {
    const source = await readFile(new URL('./startDaemon.ts', import.meta.url), 'utf8');

    const reattachIndex = source.indexOf('await reattachTrackedSessionsFromMarkers');
    const startIndex = source.indexOf('sessionLogRetentionLoopHandle = startSessionLogRetentionLoop(');
    const cleanupIndex = source.indexOf('const cleanupAndShutdown = async');
    const stopIndex = source.indexOf('sessionLogRetentionLoopHandle.stop();');
    const exitIndex = source.indexOf("logger.debug('[DAEMON RUN] Cleanup completed, exiting process');");

    expect(reattachIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeGreaterThan(reattachIndex);
    expect(source.indexOf('sessionLogRetentionLoopHandle = startSessionLogRetentionLoop(', startIndex + 1)).toBe(-1);
    expect(source.slice(startIndex, startIndex + 400)).toContain('logsDir: configuration.logsDir');
    expect(source.slice(startIndex, startIndex + 400)).toContain('protectedPaths: [logger.getLogPath()]');
    expect(cleanupIndex).toBeGreaterThan(startIndex);
    expect(stopIndex).toBeGreaterThan(cleanupIndex);
    expect(exitIndex).toBeGreaterThan(stopIndex);
  });
});
