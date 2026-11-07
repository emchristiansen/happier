function isNativeProcessExited(message) {
    return typeof message === 'object' && message !== null
        && message.type === 'terminal-native-exited'
        && (message.code === null || Number.isInteger(message.code))
        && (message.signal === null || (typeof message.signal === 'string' && message.signal.length > 0))
        && (message.code !== null || message.signal !== null);
}

function isProviderInLauncher(message) {
    return typeof message === 'object' && message !== null
        && message.type === 'terminal-provider-in-launcher';
}

function deliverProcessMessage(proc, message, failureMessage) {
    if (typeof proc.send !== 'function' || !proc.connected) return Promise.resolve();
    return new Promise((resolve) => {
        const failed = () => {
            proc.stderr.write(failureMessage);
            resolve();
        };
        try {
            proc.send(message, (error) => error ? failed() : resolve());
        } catch {
            failed();
        }
    });
}

function reportNativeProcessExited(proc, code, signal) {
    const message = { type: 'terminal-native-exited', code, signal };
    if (!isNativeProcessExited(message)) return Promise.resolve();
    return deliverProcessMessage(proc, message, 'Native process exit delivery failed (native_process_exit_delivery_failed)\n');
}

function reportProviderInLauncher(proc) {
    return deliverProcessMessage(proc, { type: 'terminal-provider-in-launcher' },
        'Provider launch mode delivery failed (provider_launch_mode_delivery_failed)\n');
}

module.exports = { isNativeProcessExited, reportNativeProcessExited, isProviderInLauncher, reportProviderInLauncher };
