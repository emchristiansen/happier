import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

type MockLogcatProcess = EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    killed?: boolean;
    kill: ReturnType<typeof vi.fn>;
};
let logcatProcess = createLogcatProcess();

function createLogcatProcess(): MockLogcatProcess {
    const process = new EventEmitter() as MockLogcatProcess;
    process.setMaxListeners(0);
    process.stdout = new PassThrough();
    process.stderr = new PassThrough();
    process.killed = false;
    process.kill = vi.fn(() => true);
    return process;
}

const pendingLogcatCloses = new Set<() => void>();

function mockExitThenClose(
    child: MockLogcatProcess,
    scheduleClose: (callback: () => void) => () => void = (callback) => {
        const timer = setTimeout(callback, 0);
        return () => clearTimeout(timer);
    },
): void {
    let active = true;
    let scheduled = false;
    let cancelClose: (() => void) | undefined;
    const dispose = () => {
        active = false;
        cancelClose?.();
        pendingLogcatCloses.delete(dispose);
    };
    pendingLogcatCloses.add(dispose);
    child.kill = vi.fn(() => {
        if (scheduled) return true;
        scheduled = true;
        queueMicrotask(() => {
            if (!active) return;
            child.emit('exit', 0);
            cancelClose = scheduleClose(() => {
                if (!active) return;
                dispose();
                child.stdout.write('05-04 13:00:01.000 1 1 I ReactNativeJS: [sync-perf] {"events":["after-exit"]}\n');
                child.emit('close', 0);
            });
        });
        return true;
    });
}

const spawnMock = vi.fn((
    _command: string,
    _args: string[],
    _options: { cwd?: string; env?: NodeJS.ProcessEnv },
) => logcatProcess);

vi.mock('node:child_process', () => ({
    spawnSync: vi.fn(() => ({ status: 0, stdout: 'package:/data/app/base.apk' })),
    spawn: spawnMock,
}));

describe('mobileMaestroRunner sync performance log capture', () => {
    afterEach(() => {
        for (const dispose of pendingLogcatCloses) dispose();
        logcatProcess.stdout.destroy();
        logcatProcess.stderr.destroy();
        logcatProcess.removeAllListeners();
        logcatProcess = createLogcatProcess();
    });

    it('writes capture diagnostics only while the artifact stream is writable', async () => {
        const { writeCapturedLogDiagnostic } = await import('./mobileMaestroRunner');
        const write = vi.fn();

        writeCapturedLogDiagnostic({ destroyed: false, writableEnded: true, write }, 'after end');
        writeCapturedLogDiagnostic({ destroyed: true, writableEnded: false, write }, 'after destroy');

        expect(write).not.toHaveBeenCalled();

        writeCapturedLogDiagnostic({ destroyed: false, writableEnded: false, write }, 'before end');

        expect(write).toHaveBeenCalledExactlyOnceWith('before end');
    });

    it('captures Android logcat into the run manifest for sync-perf parser discovery', async () => {
        const child = logcatProcess = createLogcatProcess();
        child.kill = vi.fn(() => {
            queueMicrotask(() => child.emit('close', 0));
            return true;
        });
        spawnMock.mockClear();

        const { runMobileMaestro } = await import('./mobileMaestroRunner');

        const runMaestro = vi.fn(async () => {
            child.stdout.write('05-04 13:00:00.000 1 1 I ReactNativeJS: [sync-perf] {"events":[]}\n');
            return { exitCode: 0 };
        });

        const result = await runMobileMaestro(
            {
                argv: [
                    'node',
                    'script',
                    '--platform',
                    'android',
                    '--flows',
                    'suites/mobile-e2e/flows/F12.populatedRelaySessionPerformanceSmoke.yaml',
                    '--appId',
                    'dev.happier.app.internaldev',
                    '--serverUrl',
                    'http://127.0.0.1:52753',
                    '--skip-app-install-check',
                ],
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    HAPPIER_E2E_MOBILE_MANAGE_METRO: '0',
                    HAPPIER_E2E_ANDROID_PRIME_APP_LAUNCH: '0',
                },
            },
            {
                runMaestro,
                adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
                primeAppLaunch: vi.fn(async () => {}),
            },
        );

        expect(spawnMock).toHaveBeenCalledWith(
            expect.stringMatching(/adb$/),
            expect.arrayContaining(['logcat', '-v', 'threadtime']),
            expect.objectContaining({ cwd: process.cwd() }),
        );

        const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as {
            artifacts?: {
                androidLogcat?: string;
                syncPerformanceLogs?: string[];
            };
        };
        expect(manifest.artifacts?.androidLogcat).toBe('android-logcat.log');
        expect(manifest.artifacts?.syncPerformanceLogs).toContain('android-logcat.log');
        expect(existsSync(`${result.runDir}/android-logcat.log`)).toBe(true);
        expect(readFileSync(`${result.runDir}/android-logcat.log`, 'utf8')).toContain('[sync-perf]');
        expect(logcatProcess.kill).toHaveBeenCalled();
    });

    it('waits for Android logcat close before finalizing the log artifact', async () => {
        const child = logcatProcess = createLogcatProcess();
        mockExitThenClose(child);
        spawnMock.mockClear();

        const { runMobileMaestro } = await import('./mobileMaestroRunner');

        const result = await runMobileMaestro(
            {
                argv: [
                    'node',
                    'script',
                    '--platform',
                    'android',
                    '--flows',
                    'suites/mobile-e2e/flows/F12.populatedRelaySessionPerformanceSmoke.yaml',
                    '--appId',
                    'dev.happier.app.internaldev',
                    '--serverUrl',
                    'http://127.0.0.1:52753',
                    '--skip-app-install-check',
                ],
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    HAPPIER_E2E_MOBILE_MANAGE_METRO: '0',
                    HAPPIER_E2E_ANDROID_PRIME_APP_LAUNCH: '0',
                },
            },
            {
                runMaestro: vi.fn(async () => ({ exitCode: 0 })),
                adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
                primeAppLaunch: vi.fn(async () => {}),
            },
        );

        expect(readFileSync(`${result.runDir}/android-logcat.log`, 'utf8')).toContain('after-exit');
    });

    it('keeps a delayed old logcat close from closing its successor', async () => {
        const { runMobileMaestro } = await import('./mobileMaestroRunner');
        const previous = logcatProcess = createLogcatProcess();
        const previousClose = vi.fn();
        previous.on('close', previousClose);
        const heldCloses: Array<() => void> = [];
        let onCloseScheduled!: () => void;
        const closeScheduled = new Promise<void>((resolve) => { onCloseScheduled = resolve; });
        mockExitThenClose(previous, (callback) => {
            heldCloses.push(callback);
            onCloseScheduled();
            return vi.fn();
        });
        const params = {
            argv: [
                'node', 'script', '--platform', 'android',
                '--flows', 'suites/mobile-e2e/flows/F12.populatedRelaySessionPerformanceSmoke.yaml',
                '--appId', 'dev.happier.app.internaldev',
                '--serverUrl', 'http://127.0.0.1:52753', '--skip-app-install-check',
            ],
            cwd: process.cwd(),
            env: {
                ...process.env,
                HAPPIER_E2E_MOBILE_MANAGE_METRO: '0',
                HAPPIER_E2E_ANDROID_PRIME_APP_LAUNCH: '0',
                HAPPIER_E2E_MOBILE_CONNECTED_MACHINE_MODE: '',
                HAPPIER_E2E_ANDROID_LOGCAT_CAPTURE: '1',
                HAPPIER_E2E_ANDROID_LOGCAT_STOP_TIMEOUT_MS: '1',
            },
        };
        const deps = {
            runMaestro: vi.fn(async () => ({ exitCode: 0 })),
            adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
            primeAppLaunch: vi.fn(async () => {}),
        };
        const previousRun = runMobileMaestro(params, deps);
        await closeScheduled;

        const successor = logcatProcess = createLogcatProcess();
        const successorWrite = vi.spyOn(successor.stdout, 'write');
        const successorClose = vi.fn();
        successor.on('close', successorClose);
        let onSuccessorStopping!: () => void;
        const successorStopping = new Promise<void>((resolve) => { onSuccessorStopping = resolve; });
        let escalatedBeforeCompletion = false;
        successor.kill = vi.fn((signal?: string) => {
            if (signal === 'SIGTERM') onSuccessorStopping();
            if (signal === 'SIGKILL') {
                escalatedBeforeCompletion = !successorSettled;
                queueMicrotask(() => successor.emit('close', 0));
            }
            return true;
        });
        let successorSettled = false;
        const successorRun = runMobileMaestro(params, deps).then((result) => {
            successorSettled = true;
            return result;
        });
        await successorStopping;
        expect(successorSettled).toBe(false);
        heldCloses[0]!();
        heldCloses[0]!();
        const closedByOldCallback = successorClose.mock.calls.length;
        const [previousResult] = await Promise.all([previousRun, successorRun]);

        expect(closedByOldCallback).toBe(0);
        expect(successorWrite).not.toHaveBeenCalled();
        const successorSignals = successor.kill.mock.calls.map(([signal]) => signal);
        expect(successorSignals[0]).toBe('SIGTERM');
        expect(successorSignals).toContain('SIGKILL');
        expect(escalatedBeforeCompletion).toBe(true);
        expect(successorClose).toHaveBeenCalledOnce();
        expect(heldCloses).toHaveLength(1);
        expect(previousClose).toHaveBeenCalledOnce();
        expect(pendingLogcatCloses.size).toBe(0);
        expect(readFileSync(`${previousResult.runDir}/android-logcat.log`, 'utf8')).toContain('after-exit');
        previous.stdout.destroy();
        previous.stderr.destroy();
        previous.removeAllListeners();
    });

    it('escalates Android logcat shutdown before resolving when the child ignores SIGTERM', async () => {
        const child = logcatProcess = createLogcatProcess();
        child.kill = vi.fn((signal?: string) => {
            if (signal === 'SIGKILL') {
                queueMicrotask(() => child.emit('close', 0));
            }
            return true;
        });
        spawnMock.mockClear();

        const { runMobileMaestro } = await import('./mobileMaestroRunner');

        await runMobileMaestro(
            {
                argv: [
                    'node',
                    'script',
                    '--platform',
                    'android',
                    '--flows',
                    'suites/mobile-e2e/flows/F12.populatedRelaySessionPerformanceSmoke.yaml',
                    '--appId',
                    'dev.happier.app.internaldev',
                    '--serverUrl',
                    'http://127.0.0.1:52753',
                    '--skip-app-install-check',
                ],
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    HAPPIER_E2E_MOBILE_MANAGE_METRO: '0',
                    HAPPIER_E2E_ANDROID_PRIME_APP_LAUNCH: '0',
                    HAPPIER_E2E_ANDROID_LOGCAT_STOP_TIMEOUT_MS: '1',
                },
            },
            {
                runMaestro: vi.fn(async () => ({ exitCode: 0 })),
                adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
                primeAppLaunch: vi.fn(async () => {}),
            },
        );

        const signals = logcatProcess.kill.mock.calls.map(([signal]) => signal);
        expect(signals[0]).toBe('SIGTERM');
        expect(signals).toContain('SIGKILL');
    });

    it('does not pass restore material to Android logcat capture', async () => {
        const child = logcatProcess = createLogcatProcess();
        child.kill = vi.fn(() => {
            queueMicrotask(() => child.emit('close', 0));
            return true;
        });
        spawnMock.mockClear();

        const { runMobileMaestro } = await import('./mobileMaestroRunner');

        await runMobileMaestro(
            {
                argv: [
                    'node',
                    'script',
                    '--platform',
                    'android',
                    '--flows',
                    'suites/mobile-e2e/flows/F13.populatedRelayRestoreAndOpenSessionPerformance.yaml',
                    '--appId',
                    'dev.happier.app.internaldev',
                    '--serverUrl',
                    'http://127.0.0.1:52753',
                    '--skip-app-install-check',
                ],
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    HAPPIER_E2E_MOBILE_MANAGE_METRO: '0',
                    HAPPIER_E2E_ANDROID_PRIME_APP_LAUNCH: '0',
                    HAPPIER_E2E_RESTORE_KEY: 'RESTORE-KEY-THAT-MUST-NOT-REACH-LOGCAT',
                },
            },
            {
                runMaestro: vi.fn(async () => ({ exitCode: 0 })),
                adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
                primeAppLaunch: vi.fn(async () => {}),
            },
        );

        const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
        expect(spawnOptions?.env?.HAPPIER_E2E_RESTORE_KEY).toBeUndefined();
    });

    it('captures iOS simulator logs into the run manifest for sync-perf parser discovery', async () => {
        const child = logcatProcess = createLogcatProcess();
        child.kill = vi.fn(() => {
            queueMicrotask(() => child.emit('close', 0));
            return true;
        });
        spawnMock.mockClear();

        const { runMobileMaestro } = await import('./mobileMaestroRunner');

        const runMaestro = vi.fn(async () => {
            child.stdout.write('ReactNativeJS: [sync-perf] {"events":["ios"]}\n');
            return { exitCode: 0 };
        });

        const result = await runMobileMaestro(
            {
                argv: [
                    'node',
                    'script',
                    '--platform',
                    'ios',
                    '--flows',
                    'suites/mobile-e2e/flows/F12.populatedRelaySessionPerformanceSmoke.yaml',
                    '--appId',
                    'dev.happier.app.publicdev',
                    '--serverUrl',
                    'http://127.0.0.1:52753',
                    '--skip-app-install-check',
                ],
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    HAPPIER_E2E_MOBILE_MANAGE_METRO: '0',
                },
            },
            {
                runMaestro,
                adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
            },
        );

        expect(spawnMock).toHaveBeenCalledWith(
            expect.stringMatching(/xcrun$/),
            expect.arrayContaining(['simctl', 'spawn', 'booted', 'log', 'stream']),
            expect.objectContaining({ cwd: process.cwd() }),
        );

        const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as {
            artifacts?: {
                iosSimulatorLog?: string;
                syncPerformanceLogs?: string[];
            };
        };
        expect(manifest.artifacts?.iosSimulatorLog).toBe('ios-simulator.log');
        expect(manifest.artifacts?.syncPerformanceLogs).toContain('ios-simulator.log');
        expect(readFileSync(`${result.runDir}/ios-simulator.log`, 'utf8')).toContain('[sync-perf]');
    });

    it('escalates iOS simulator log shutdown before resolving when the child ignores SIGTERM', async () => {
        const child = logcatProcess = createLogcatProcess();
        child.kill = vi.fn((signal?: string) => {
            if (signal === 'SIGKILL') {
                queueMicrotask(() => child.emit('close', 0));
            }
            return true;
        });
        spawnMock.mockClear();

        const { runMobileMaestro } = await import('./mobileMaestroRunner');

        await runMobileMaestro(
            {
                argv: [
                    'node',
                    'script',
                    '--platform',
                    'ios',
                    '--flows',
                    'suites/mobile-e2e/flows/F12.populatedRelaySessionPerformanceSmoke.yaml',
                    '--appId',
                    'dev.happier.app.publicdev',
                    '--serverUrl',
                    'http://127.0.0.1:52753',
                    '--skip-app-install-check',
                ],
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    HAPPIER_E2E_MOBILE_MANAGE_METRO: '0',
                    HAPPIER_E2E_IOS_SIMULATOR_LOG_STOP_TIMEOUT_MS: '1',
                },
            },
            {
                runMaestro: vi.fn(async () => ({ exitCode: 0 })),
                adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
            },
        );

        const signals = logcatProcess.kill.mock.calls.map(([signal]) => signal);
        expect(signals[0]).toBe('SIGTERM');
        expect(signals).toContain('SIGKILL');
    });

    it('redacts generated terminal-connect deep links from runtime log artifacts', async () => {
        logcatProcess = createLogcatProcess();
        logcatProcess.kill = vi.fn(() => {
            queueMicrotask(() => logcatProcess.emit('close', 0));
            return true;
        });
        spawnMock.mockClear();

        const { runMobileMaestro } = await import('./mobileMaestroRunner');

        const runMaestro = vi.fn(async (params: { env: NodeJS.ProcessEnv }) => {
            const deepLink = String(params.env.HAPPIER_E2E_TERMINAL_CONNECT_DEEP_LINK ?? '');
            if (deepLink) {
                logcatProcess.stdout.write(`ReactNativeJS: opening ${deepLink}\n`);
            }
            return { exitCode: 0 };
        });

        const result = await runMobileMaestro(
            {
                argv: [
                    'node',
                    'script',
                    '--platform',
                    'android',
                    '--flows',
                    'suites/mobile-e2e/flows/F4.connectedMachineComposerSmoke.yaml',
                    '--appId',
                    'dev.happier.app.internaldev',
                    '--skip-app-install-check',
                ],
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    HAPPIER_E2E_MOBILE_MANAGE_METRO: '0',
                    HAPPIER_E2E_ANDROID_PRIME_APP_LAUNCH: '0',
                    HAPPIER_E2E_MOBILE_CONNECTED_MACHINE_MODE: 'cli-terminal-daemon',
                },
            },
            {
                startServerLight: vi.fn(async () => ({
                    baseUrl: 'http://127.0.0.1:43210',
                    port: 43210,
                    stop: vi.fn(async () => {}),
                })),
                startCliTerminalConnect: vi.fn(async () => ({
                    connectUrl: 'https://example.test/terminal/connect#key=test-key&server=http%3A%2F%2F127.0.0.1%3A43210',
                    waitForSuccess: vi.fn(async () => {}),
                    stop: vi.fn(async () => {}),
                })),
                startTestDaemon: vi.fn(async () => ({
                    stop: vi.fn(async () => {}),
                })),
                runMaestro,
                adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
                primeAppLaunch: vi.fn(async () => {}),
            },
        );

        const logText = readFileSync(`${result.runDir}/android-logcat.log`, 'utf8');
        expect(logText).not.toContain('test-key');
        expect(logText).toContain('[redacted:HAPPIER_E2E_TERMINAL_CONNECT_DEEP_LINK]');
    });
});
