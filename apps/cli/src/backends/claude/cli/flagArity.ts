const flagsWithRequiredValue = new Set<string>([
    '--add-dir',
    '--agent',
    '--agents',
    '--allowedTools',
    '--allowed-tools',
    '--append-system-prompt',
    '--append-system-prompt-file',
    '--betas',
    '--debug-file',
    '--disallowedTools',
    '--disallowed-tools',
    '--effort',
    '--fallback-model',
    '--file',
    '--input-format',
    '--json-schema',
    '--max-budget-usd',
    '--max-turns',
    '--mcp-config',
    '--model',
    '--name',
    '-n',
    '--output-format',
    '--permission-mode',
    '--print',
    '-p',
    '--plugin-dir',
    '--plugin-url',
    '--remote-control-session-name-prefix',
    '--session-id',
    '--setting-sources',
    '--settings',
    '--system-prompt',
    '--system-prompt-file',
    '--tools',
]);

const flagsWithOptionalValue = new Set<string>(['--resume', '-r']);

export function claudeCliFlagHasRequiredValue(flag: string): boolean {
    return flagsWithRequiredValue.has(flag);
}

export function claudeCliFlagHasOptionalValue(flag: string): boolean {
    return flagsWithOptionalValue.has(flag);
}

export function claudeCliFlagCanConsumeNextArg(flag: string, nextArg: string | undefined): boolean {
    if (nextArg === undefined) return false;
    if (claudeCliFlagHasRequiredValue(flag)) return true;
    return claudeCliFlagHasOptionalValue(flag) && !nextArg.startsWith('-');
}
