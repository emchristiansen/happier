export type ConnectParsedOptions = Readonly<{
  profileId: string;
  paste: boolean;
  device: boolean;
  noOpen: boolean;
  timeoutSeconds: number | null;
  setupToken: boolean;
  oauth: boolean;
  apiKey: boolean;
  token: boolean;
}>;

/**
 * What `--profile` said, as given: absent, present without a usable value (nothing, blank, or
 * another flag in its place), or an exact profile id. `options.profileId` keeps its connect
 * <target> meaning, where anything but a value falls back to `default`.
 */
export type ConnectProfileFlag =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'missing_value' }>
  | Readonly<{ kind: 'value'; profileId: string }>;

export function parseConnectArgs(args: ReadonlyArray<string>): Readonly<{
  includeExperimental: boolean;
  subcommand: string | null;
  profileFlag: ConnectProfileFlag;
  options: ConnectParsedOptions;
}> {
  const includeExperimental = args.includes('--all') || args.includes('--experimental');
  const paste = args.includes('--paste');
  const device = args.includes('--device');
  const noOpen = args.includes('--no-open');
  const setupToken = args.includes('--setup-token') || args.includes('--setup_token');
  const oauth = args.includes('--oauth');
  const apiKey = args.includes('--api-key') || args.includes('--api_key');
  const token = args.includes('--token');

  const profileFlagIdx = args.findIndex((a) => a === '--profile');
  const profileId = profileFlagIdx !== -1 ? String(args[profileFlagIdx + 1] ?? '').trim() : '';
  const profileFlag: ConnectProfileFlag = profileFlagIdx === -1
    ? { kind: 'absent' }
    : profileId && !profileId.startsWith('--')
      ? { kind: 'value', profileId }
      : { kind: 'missing_value' };

  const timeoutFlagIdx = args.findIndex((a) => a === '--timeout');
  const timeoutRaw = timeoutFlagIdx !== -1 ? String(args[timeoutFlagIdx + 1] ?? '').trim() : '';
  const timeoutSeconds = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : NaN;
  const timeoutSecondsValue = Number.isFinite(timeoutSeconds) ? Math.max(1, Math.trunc(timeoutSeconds)) : null;

  const knownFlags = new Set([
    '--all',
    '--experimental',
    '--paste',
    '--device',
    '--no-open',
    '--setup-token',
    '--setup_token',
    '--oauth',
    '--api-key',
    '--api_key',
    '--token',
    '--profile',
    '--timeout',
  ]);
  const valuesConsumedByFlags = new Set<number>([
    profileFlagIdx !== -1 ? profileFlagIdx + 1 : -1,
    timeoutFlagIdx !== -1 ? timeoutFlagIdx + 1 : -1,
  ]);

  const positional = args
    .filter((_a, idx) => !valuesConsumedByFlags.has(idx))
    .filter((a) => !knownFlags.has(a))
    .filter((a) => !a.startsWith('--'));

  const subcommand = positional[0] ?? null;
  return {
    includeExperimental,
    subcommand,
    profileFlag,
    options: {
      profileId: profileId || 'default',
      paste,
      device,
      noOpen,
      timeoutSeconds: timeoutSecondsValue,
      setupToken,
      oauth,
      apiKey,
      token,
    },
  };
}
