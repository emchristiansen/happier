#!/usr/bin/env node

/**
 * Ripgrep runner - executed as a subprocess to run the packaged binary
 * This file is intentionally written in CommonJS to avoid ESM complexities
 *
 * Fallback chain:
 * - Use the packaged target-specific rg executable
 * - Fall back to system ripgrep when the packaged executable is unavailable
 * - Fallback: Mock implementation with helpful guidance
 */

const path = require('path');
const fs = require('fs');
const { withWindowsHide } = require('./childProcessOptions.cjs');

// Find ripgrep in system PATH (cross-platform)
function findSystemRipgrep() {
    const { execFileSync } = require('child_process');

    // Platform-specific commands to find ripgrep
    const commands = [
        // Windows: Use where command
        process.platform === 'win32' && { cmd: 'where', args: ['rg'] },
        // Unix-like: Use which command
        process.platform !== 'win32' && { cmd: 'which', args: ['rg'] }
    ].filter(Boolean);

    for (const { cmd, args } of commands) {
        try {
            const result = execFileSync(cmd, args, withWindowsHide({
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            }));

            if (result) {
                const paths = result.trim().split('\n').filter(Boolean);
                if (paths.length > 0) {
                    return paths[0].trim();
                }
            }
        } catch {
            // Command failed, try next one
            continue;
        }
    }

    // Fallback: Try common installation paths directly
    const commonPaths = [];
    if (process.platform === 'win32') {
        commonPaths.push(
            'C:\\Program Files\\ripgrep\\rg.exe',
            'C:\\Program Files (x86)\\ripgrep\\rg.exe'
        );
    } else if (process.platform === 'darwin') {
        commonPaths.push(
            '/opt/homebrew/bin/rg',
            '/usr/local/bin/rg'
        );
    } else if (process.platform === 'linux') {
        commonPaths.push(
            '/usr/bin/rg',
            '/usr/local/bin/rg',
            '/opt/homebrew/bin/rg'
        );
    }

    for (const testPath of commonPaths) {
        if (fs.existsSync(testPath)) {
            return testPath;
        }
    }

    return null;
}

// Create wrapper that mimics native addon interface
function createRipgrepWrapper(binaryPath) {
    return {
        ripgrepMain: (args) => {
            const { spawnSync } = require('child_process');
            const result = spawnSync(binaryPath, args, withWindowsHide({
                stdio: 'inherit',
                cwd: process.cwd()
            }));
            if (result.error) throw result.error;
            if (typeof result.status === 'number') return result.status;
            if (result.signal) return 1;
            return 1;
        }
    };
}

// Create mock that doesn't crash but provides useful feedback
function createMockRipgrep() {
    return {
        ripgrepMain: (args) => {
            if (args.includes('--version')) {
                console.log('ripgrep 0.0.0 (mock)');
                return 0;
            }

            console.error('Search functionality unavailable without ripgrep');
            console.error('See installation instructions above');
            return 1;
        }
    };
}

function resolvePackagedRipgrepPath(toolsDir, platform = process.platform) {
    const binaryPath = path.join(toolsDir, platform === 'win32' ? 'rg.exe' : 'rg');
    return fs.existsSync(binaryPath) ? binaryPath : null;
}

// Load ripgrep with graceful fallback chain
function loadRipgrep() {
    const toolsDir = path.join(__dirname, '..', 'tools', 'unpacked');
    const packagedRipgrep = resolvePackagedRipgrepPath(toolsDir);
    if (packagedRipgrep) {
        return createRipgrepWrapper(packagedRipgrep);
    }

    // Preserve the existing system fallback for development/npm layouts whose
    // packaged tool is unavailable.
    const systemRipgrep = findSystemRipgrep();
    if (systemRipgrep) {
        console.error(`Using system ripgrep: ${systemRipgrep}`);
        return createRipgrepWrapper(systemRipgrep);
    }

    // Final fallback: Return mock implementation that provides helpful guidance
    console.warn('\n⚠️  ripgrep not available - search functionality limited');
    console.warn('Install ripgrep for full functionality:');

    if (process.platform === 'win32') {
        console.warn('  • Windows: winget install BurntSushi.ripgrep');
        console.warn('  • Or download from: https://github.com/BurntSushi/ripgrep/releases');
    } else {
        console.warn('  • macOS/Linux: brew install ripgrep');
        console.warn('  • npm: npm install -g @silentsilas/ripgrep-bin');
    }
    console.warn('');

    return createMockRipgrep();
}

function main(argv = process.argv.slice(2)) {
    let parsedArgs;
    try {
        if (!argv[0]) {
            console.error('Missing arguments: expected JSON-encoded argv as the first parameter.');
            console.error('Example: node scripts/ripgrep_launcher.cjs \'["--version"]\'');
            return 1;
        }
        parsedArgs = JSON.parse(argv[0]);
        if (!Array.isArray(parsedArgs) || !parsedArgs.every((arg) => typeof arg === 'string')) {
            throw new TypeError('expected an array of strings');
        }
    } catch (error) {
        console.error('Failed to parse arguments:', error.message);
        return 1;
    }

    try {
        return loadRipgrep().ripgrepMain(parsedArgs);
    } catch (error) {
        console.error('Ripgrep error:', error.message);
        return 1;
    }
}

module.exports = { main, resolvePackagedRipgrepPath };

if (require.main === module) {
    const exitCode = main();
    if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
        console.error(`Ripgrep error: invalid exit code ${exitCode}`);
        process.exit(1);
    }
    process.exit(exitCode);
}
