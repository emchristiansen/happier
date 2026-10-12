import chalk from 'chalk';

import { AGENT_IDS, getProviderCliRuntimeSpec, type AgentId } from '@happier-dev/agents';

import type { CommandContext } from '@/cli/commandRegistry';
import type {
  invokeProviderCliInstall as invokeProviderCliInstallDefault,
} from '@/runtime/managedTools/invokeProviderCliInstall';
import type { runDoctorCommand as runDoctorCommandDefault } from '@/ui/doctor';
import { createStepPrinter, fail } from '@happier-dev/cli-common/output';
import { describeProviderCliInstallMode, runProviderCliInstallStep } from '@/runtime/managedTools/providerCliInstallStep';

function usage(): string {
  return [
    `${chalk.bold('happier install')} - Installation helpers`,
    '',
    `${chalk.bold('Usage:')}`,
    '  happier install doctor',
    '  happier install provider <providerId> [--dry-run] [--force]',
    '',
  ].join('\n');
}

type InstallCliDeps = Readonly<{
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => never | void;
  runDoctorCommand: typeof runDoctorCommandDefault;
  invokeProviderCliInstall: typeof invokeProviderCliInstallDefault;
}>;

async function runDoctorCommandLazy(): Promise<void> {
  const { runDoctorCommand } = await import('@/ui/doctor');
  await runDoctorCommand();
}

async function invokeProviderCliInstallLazy(
  ...args: Parameters<typeof invokeProviderCliInstallDefault>
): Promise<Awaited<ReturnType<typeof invokeProviderCliInstallDefault>>> {
  const { invokeProviderCliInstall } = await import('@/runtime/managedTools/invokeProviderCliInstall');
  return await invokeProviderCliInstall(...args);
}

function parseProviderInstallFlags(args: readonly string[]): Readonly<{ dryRun: boolean; skipIfInstalled: boolean }> {
  return {
    dryRun: args.includes('--dry-run'),
    skipIfInstalled: !args.includes('--force'),
  };
}

function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

export async function runInstallCliCommand(
  context: CommandContext,
  deps: InstallCliDeps = {
    log: console.log,
    error: console.error,
    exit: (code: number) => {
      process.exitCode = code;
    },
    runDoctorCommand: runDoctorCommandLazy,
    invokeProviderCliInstall: invokeProviderCliInstallLazy,
  },
): Promise<void> {
  try {
    const subcommand = context.args[1] ?? 'help';
    if (subcommand === 'doctor') {
      await deps.runDoctorCommand();
      return;
    }
    if (subcommand === 'provider') {
      const providerIdRaw = context.args[2]?.trim() ?? '';
      if (!providerIdRaw) {
        deps.error(fail('Missing provider id.'));
        deps.log(usage());
        deps.exit(1);
        return;
      }
      if (providerIdRaw === 'help' || providerIdRaw === '--help' || providerIdRaw === '-h') {
        deps.log(usage());
        return;
      }
      if (!isAgentId(providerIdRaw)) {
        deps.error(fail(`Unknown provider id: ${providerIdRaw}`));
        deps.log(usage());
        deps.exit(1);
        return;
      }

      const flags = parseProviderInstallFlags(context.args.slice(3));
      // A dry run installs nothing, so it prints its plan instead of an install step.
      const steps = createStepPrinter({ enabled: !flags.dryRun });
      const result = await runProviderCliInstallStep(steps, getProviderCliRuntimeSpec(providerIdRaw).title, () => deps.invokeProviderCliInstall({
        agentId: providerIdRaw,
        params: flags,
        env: process.env,
        nodePlatform: process.platform,
      }));
      if (!result.ok) {
        deps.error(fail(result.errorMessage));
        if (result.logPath) {
          deps.log(`Install log: ${result.logPath}`);
        }
        deps.exit(1);
        return;
      }
      if (flags.dryRun) {
        deps.log(`Dry run: would install ${result.plan.title} via ${describeProviderCliInstallMode(result.plan.installMode)}.`);
        if (result.logPath) {
          deps.log(`Install log: ${result.logPath}`);
        }
        return;
      }
      if (result.logPath) {
        deps.log(`Install log: ${result.logPath}`);
      }
      return;
    }
    if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
      deps.log(usage());
      return;
    }
    deps.error(fail(`Unknown install subcommand: ${subcommand}`));
    deps.log(usage());
    deps.exit(1);
  } catch (error) {
    deps.error(fail(error instanceof Error ? error.message : 'Unknown error'));
    if (process.env.DEBUG) {
      deps.error(error);
    }
    if (error && typeof error === 'object' && 'logPath' in error && typeof error.logPath === 'string') {
      deps.log(`Install log: ${error.logPath}`);
    }
    deps.exit(1);
    return;
  }
}

export async function handleInstallCliCommand(context: CommandContext): Promise<void> {
  await runInstallCliCommand(context);
}
