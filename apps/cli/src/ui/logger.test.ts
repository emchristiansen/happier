import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

/**
 * The removed constructor-time prune was fire-and-forget async fs work with no completion
 * handle. Give any such work generous wall time to land before asserting nothing was removed.
 */
async function settleBackgroundFsWork(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
}

describe('logger', () => {
    const envKeys = ['DEBUG', 'HAPPIER_HOME_DIR', 'HAPPIER_LOG_LEVEL', 'HAPPIER_SESSION_LOG_KEEP_COUNT', 'HAPPIER_CRASHED_SESSION_LOG_KEEP_COUNT'] as const;
    let envScope = createEnvKeyScope(envKeys);
    let tempDir: string;
    let originalArgv: string[];

    beforeEach(() => {
        envScope = createEnvKeyScope(envKeys);
        tempDir = createTempDirSync('happier-cli-logger-test-');
        originalArgv = [...process.argv];
        envScope.patch({
            HAPPIER_HOME_DIR: tempDir,
            DEBUG: undefined,
            HAPPIER_LOG_LEVEL: undefined,
            HAPPIER_SESSION_LOG_KEEP_COUNT: undefined,
            HAPPIER_CRASHED_SESSION_LOG_KEEP_COUNT: undefined,
        });
        vi.resetModules();
    });

    afterEach(() => {
        removeTempDirSync(tempDir);
        envScope.restore();
        process.argv = originalArgv;
    });

    it('does not write to log file when DEBUG is not set', async () => {
        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        logger.debugLargeJson('[TEST] debugLargeJson', { secret: 'value' });
        logger.flushSync();

        expect(existsSync(logger.getLogPath())).toBe(false);
    });

    it('writes to log file when DEBUG is set', async () => {
        process.env.DEBUG = '1';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        logger.debugLargeJson('[TEST] debugLargeJson', { secret: 'value' });
        logger.flushSync();

        expect(existsSync(logger.getLogPath())).toBe(true);
        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).toContain('[TEST] debugLargeJson');
    });

    it('gates logger.debug off by default in session processes', async () => {
        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        logger.debug('[TEST] should not be written', { payload: 'value' });
        logger.flushSync();

        expect(existsSync(logger.getLogPath())).toBe(false);
    });

    it('enables logger.debug via HAPPIER_LOG_LEVEL=debug', async () => {
        process.env.HAPPIER_LOG_LEVEL = 'debug';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        logger.debug('[TEST] level override', { payload: 'value' });
        logger.flushSync();

        expect(existsSync(logger.getLogPath())).toBe(true);
        expect(readFileSync(logger.getLogPath(), 'utf8')).toContain('[TEST] level override');
    });

    it('keeps logger.debug enabled by default in daemon processes', async () => {
        process.argv = ['node', 'happier', 'daemon', 'start'];

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        logger.debug('[TEST] daemon debug default');
        logger.flushSync();

        expect(readFileSync(logger.getLogPath(), 'utf8')).toContain('[TEST] daemon debug default');
    });

    it('still writes info and warn entries to the log file when debug is disabled', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        try {
            logger.info('[TEST] info entry');
            logger.warn('[TEST] warn entry');
        } finally {
            logSpy.mockRestore();
        }
        logger.flushSync();

        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).toContain('[TEST] info entry');
        expect(content).toContain('[WARN] [TEST] warn entry');
    });

    it('writes file-only info diagnostics without polluting the interactive console', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        logger.infoFile('[TEST] file-only incident', { queueName: 'test-queue' });
        logger.flushSync();

        expect(logSpy).not.toHaveBeenCalled();
        expect(readFileSync(logger.getLogPath(), 'utf8')).toContain('[TEST] file-only incident');
        logSpy.mockRestore();
    });

    it('durably records sanitized fatal errors without serializing argv or env fields', async () => {
        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');
        const error = Object.assign(
            new Error('provider startup rejected; Authorization: Bearer fatal-secret-token'),
            {
                argv: ['--token', 'argv-secret-value'],
                env: { OPENAI_API_KEY: 'env-secret-value' },
            },
        );

        expect(() => logger.fatal(error)).not.toThrow();

        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).toContain('[FATAL] Unhandled CLI error');
        expect(content).toContain('provider startup rejected');
        expect(content).toContain('[REDACTED]');
        expect(content).not.toContain('fatal-secret-token');
        expect(content).not.toContain('argv-secret-value');
        expect(content).not.toContain('env-secret-value');
        expect(content).not.toContain('OPENAI_API_KEY');
    });

    it('keeps fatal reporting best-effort when thrown values cannot be inspected', async () => {
        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');
        const hostileError = {
            get stack(): string {
                throw new Error('stack getter failed');
            },
            get message(): string {
                throw new Error('message getter failed');
            },
            toString(): string {
                throw new Error('toString failed');
            },
        };

        expect(() => logger.fatal(hostileError)).not.toThrow();
        expect(readFileSync(logger.getLogPath(), 'utf8')).toContain('[FATAL] Unhandled CLI error');
    });

    it('writes Error objects with message/stack instead of "{}" when DEBUG is set', async () => {
        process.env.DEBUG = '1';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        logger.debug('[TEST] error serialization', new Error('boom'));
        logger.flushSync();

        expect(existsSync(logger.getLogPath())).toBe(true);
        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).toContain('[TEST] error serialization');
        expect(content).toContain('boom');
    });

    it('writes a NESTED Error with its message and code instead of "{}"', async () => {
        // The observed defect: every daemon failure logged as `{ pid, error }`
        // reached the log file as `{"pid":95632,"error":{}}`, because an Error
        // carries no enumerable own properties for `JSON.stringify` to find. The
        // top-level case was already handled; the carrying object — which is how
        // these are actually logged — was not, and root-causing a permanently
        // broken stop path cost a lane real time for exactly that reason.
        process.env.DEBUG = '1';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        const error = Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' });
        logger.debug('[TEST] nested error serialization', { pid: 95632, error });
        logger.debugLargeJson('[TEST] nested error in large json', { pid: 95632, error });
        logger.flushSync();

        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).not.toContain('"error":{}');
        for (const marker of ['[TEST] nested error serialization', '[TEST] nested error in large json']) {
            const line = content.split(marker)[1] ?? '';
            expect(line).toContain('directory not empty');
            expect(line).toContain('ENOTEMPTY');
            expect(line).toContain('95632');
        }
    });

    it('does not throw when a nested error causes a cycle', async () => {
        process.env.DEBUG = '1';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        const error: Error & { cause?: unknown } = new Error('looping');
        error.cause = error;

        expect(() => {
            logger.debug('[TEST] nested cyclic error', { pid: 1, error });
        }).not.toThrow();
        logger.flushSync();

        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).toContain('[TEST] nested cyclic error');
        expect(content).toContain('looping');
    });

    it('does not throw when debugLargeJson receives circular objects', async () => {
        process.env.DEBUG = '1';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        const obj: { a: number; self?: unknown } = { a: 1 };
        obj.self = obj;

        expect(() => {
            logger.debugLargeJson('[TEST] circular json', obj);
        }).not.toThrow();
        logger.flushSync();

        expect(existsSync(logger.getLogPath())).toBe(true);
        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).toContain('[TEST] circular json');
    });

    it('does not throw when logging a cross-realm Error with circular refs', async () => {
        process.env.DEBUG = '1';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        const ctx = createContext({});
        const err = runInContext(
            "(() => { const e = new Error('boom'); e.error = e; return e; })()",
            ctx,
        );

        expect(err instanceof Error).toBe(false);

        expect(() => {
            logger.debug('[TEST] cross-realm error', err);
        }).not.toThrow();
        logger.flushSync();

        expect(existsSync(logger.getLogPath())).toBe(true);
        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).toContain('[TEST] cross-realm error');
        expect(content).toContain('boom');
    });

    it('creates logs dir on demand when writing the first debug entry', async () => {
        process.env.DEBUG = '1';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');
        const logsDir = dirname(logger.getLogPath());
        rmSync(logsDir, { recursive: true, force: true });

        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            logger.debugLargeJson('[TEST] create logs dir', { secret: 'value' });
            logger.flushSync();
        } finally {
            errorSpy.mockRestore();
        }

        expect(existsSync(logsDir)).toBe(true);
        expect(existsSync(logger.getLogPath())).toBe(true);
        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).toContain('[TEST] create logs dir');
    });

    it('does not throw if log file cannot be written (even when DEBUG is set)', async () => {
        process.env.DEBUG = '1';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');
        // Deterministic cross-platform write failure: path points to a directory, not a file.
        mkdirSync(logger.getLogPath(), { recursive: true });
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
            expect(() => {
                logger.debugLargeJson('[TEST] debugLargeJson write should not throw', { secret: 'value' });
                logger.flushSync();
            }).not.toThrow();
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('does not throw when console logging hits EPIPE', async () => {
        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');
        const epipeError = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {
            throw epipeError;
        });

        try {
            expect(() => {
                logger.warn('[TEST] warn survives broken stdout');
            }).not.toThrow();
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('never prunes the logs dir when constructing a logger with daemon argv: the running daemon trims from its retention loop', async () => {
        process.argv = ['node', 'happier', 'daemon', 'start-sync'];
        const logsDir = join(tempDir, 'logs');
        mkdirSync(logsDir, { recursive: true });
        const fixtures: string[] = [];
        // 60 > DEFAULT_DAEMON_LOG_KEEP_COUNT (50).
        for (let index = 0; index < 60; index += 1) {
            const name = `2026-06-30-10-${String(index).padStart(2, '0')}-00-pid-${4_300_000 + index}-daemon.log`;
            writeFileSync(join(logsDir, name), `old ${index}\n`, 'utf8');
            fixtures.push(name);
        }

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');
        logger.debug('[TEST] current daemon log');
        logger.flushSync();
        await settleBackgroundFsWork();

        const entries = readdirSync(logsDir);
        expect(fixtures.filter(fixture => !entries.includes(fixture))).toEqual([]);
        expect(entries).toContain(logger.getLogPath().split('/').pop());
    });

    it('never prunes the logs dir when constructing a non-daemon logger, even for old dead-runner logs past every budget', async () => {
        const logsDir = join(tempDir, 'logs');
        const sessionExitDir = join(logsDir, 'session-exit');
        mkdirSync(sessionExitDir, { recursive: true });
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const fixtures: string[] = [];
        // 250 > DEFAULT_SESSION_LOG_KEEP_COUNT (200). Pids above Linux pid_max (2^22) and macOS
        // PID_MAX can never be alive, so every fixture is an old, dead-runner session log.
        for (let index = 0; index < 250; index += 1) {
            const name = `2026-01-01-10-${String(Math.floor(index / 60)).padStart(2, '0')}-${String(index % 60).padStart(2, '0')}-pid-${4_200_000 + index}.log`;
            writeFileSync(join(logsDir, name), `old session ${index}\n`, 'utf8');
            utimesSync(join(logsDir, name), thirtyDaysAgo, thirtyDaysAgo);
            fixtures.push(name);
        }
        for (let index = 0; index < 60; index += 1) {
            const name = `2026-01-01-09-${String(index).padStart(2, '0')}-00-pid-${4_300_000 + index}-daemon.log`;
            writeFileSync(join(logsDir, name), `old daemon ${index}\n`, 'utf8');
            utimesSync(join(logsDir, name), thirtyDaysAgo, thirtyDaysAgo);
            fixtures.push(name);
        }

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');
        logger.info('[TEST] session logger constructed');
        logger.flushSync();
        await settleBackgroundFsWork();

        const entries = readdirSync(logsDir);
        for (const fixture of fixtures) {
            expect(entries).toContain(fixture);
        }
    });

    it('registers process flush hooks only once across repeated logger module reloads', async () => {
        await import('@/ui/logger');
        const exitListenersAfterFirstImport = process.listenerCount('exit');
        const uncaughtListenersAfterFirstImport = process.listenerCount('uncaughtExceptionMonitor');

        vi.resetModules();
        await import('@/ui/logger');
        vi.resetModules();
        await import('@/ui/logger');

        expect(process.listenerCount('exit')).toBe(exitListenersAfterFirstImport);
        expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(uncaughtListenersAfterFirstImport);
    });
});
