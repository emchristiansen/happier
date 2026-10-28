export type CommandInvocation = Readonly<{
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}>;
export function resolveWindowsCommandPath(commandPath: string, env?: NodeJS.ProcessEnv): string | null;
export function resolveWindowsCommandOnPath(
  command: string,
  env?: NodeJS.ProcessEnv,
  accept?: (candidate: string) => boolean,
): string | null;
export function buildWindowsCmdShimInvocation(
  command: string,
  args: readonly string[],
  options?: Readonly<{ env?: NodeJS.ProcessEnv; comspec?: string | null }>,
): CommandInvocation;
export function resolveWindowsCommandInvocation(params: Readonly<{
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  comspec?: string | null;
  resolveCommandOnPath?: boolean;
}>): CommandInvocation;
