import { spawn } from 'node:child_process';


import { isTmuxAvailable, normalizeExitCode } from '@/integrations/tmux';

import { createTerminalAttachPlan } from './terminalAttachPlan';
import { createTmuxSingleWindowAttachPlan } from './tmuxSingleWindowAttachPlan';
import type { TerminalAttachmentInfo } from './terminalAttachmentInfo';
import { fail } from '@happier-dev/cli-common/output';

function spawnTmux(params: {
  args: string[];
  env: NodeJS.ProcessEnv;
  stdio: 'inherit' | 'ignore';
}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('tmux', params.args, {
      stdio: params.stdio,
      env: params.env,
      shell: false,
    });

    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(normalizeExitCode(code)));
  });
}

type SpawnTmuxFn = typeof spawnTmux;

export async function runTmuxAttach(params: {
  sessionId: string;
  terminal: NonNullable<TerminalAttachmentInfo['terminal']>;
  refreshRemoteControl?: boolean;
}, deps?: Readonly<{
  isTmuxAvailableFn?: typeof isTmuxAvailable;
  spawnTmuxFn?: SpawnTmuxFn;
  insideTmux?: boolean;
  currentTmuxSocketPath?: string | null;
  processId?: number;
  nowMs?: number;
}>): Promise<number> {
  const isTmuxAvailableFn = deps?.isTmuxAvailableFn ?? isTmuxAvailable;
  if (!(await isTmuxAvailableFn())) {
    console.error(fail('tmux is not available on this machine.'));
    return 1;
  }

  const insideTmux = deps?.insideTmux ?? Boolean(process.env.TMUX);
  const currentTmuxSocketPath = deps && Object.prototype.hasOwnProperty.call(deps, 'currentTmuxSocketPath')
    ? deps.currentTmuxSocketPath
    : typeof process.env.TMUX === 'string'
      ? process.env.TMUX.split(',')[0]?.trim() || null
      : null;
  const plan = createTerminalAttachPlan({
    terminal: params.terminal,
    insideTmux,
    currentTmuxSocketPath,
  });

  if (plan.type === 'not-attachable') {
    console.error(fail(plan.reason));
    return 1;
  }
  if (plan.type !== 'tmux') {
    console.error(fail('Session does not use tmux attach.'));
    return 1;
  }

  const env: NodeJS.ProcessEnv = { ...process.env, ...plan.tmuxCommandEnv };
  if (plan.shouldUnsetTmuxEnv) {
    delete env.TMUX;
    delete env.TMUX_PANE;
  }
  const spawnTmuxFn = deps?.spawnTmuxFn ?? spawnTmux;

  const selectExit = await spawnTmuxFn({
    args: plan.selectWindowArgs,
    env,
    stdio: 'ignore',
  });

  if (selectExit !== 0) {
    console.error(fail(`Failed to select tmux window (${plan.target}).`));
    return selectExit;
  }

  if (params.refreshRemoteControl === true) {
    await spawnTmuxFn({
      args: ['send-keys', '-t', plan.target, 'C-l'],
      env,
      stdio: 'ignore',
    });
  }

  if (!plan.shouldAttach) return 0;

  const singleWindowAttachPlan = createTmuxSingleWindowAttachPlan({
    sessionId: params.sessionId,
    target: plan.target,
    processId: deps?.processId,
    nowMs: deps?.nowMs,
  });

  const createExit = await spawnTmuxFn({ args: singleWindowAttachPlan.createSessionArgs, env, stdio: 'ignore' });
  if (createExit !== 0) return createExit;

  const linkExit = await spawnTmuxFn({ args: singleWindowAttachPlan.linkWindowArgs, env, stdio: 'ignore' });
  if (linkExit !== 0) {
    await spawnTmuxFn({ args: singleWindowAttachPlan.cleanupSessionArgs, env, stdio: 'ignore' });
    return linkExit;
  }

  const killPlaceholderExit = await spawnTmuxFn({ args: singleWindowAttachPlan.killPlaceholderWindowArgs, env, stdio: 'ignore' });
  if (killPlaceholderExit !== 0) {
    await spawnTmuxFn({ args: singleWindowAttachPlan.cleanupSessionArgs, env, stdio: 'ignore' });
    return killPlaceholderExit;
  }

  const attachExit = await spawnTmuxFn({ args: singleWindowAttachPlan.attachSessionArgs, env, stdio: 'inherit' });
  await spawnTmuxFn({ args: singleWindowAttachPlan.cleanupSessionArgs, env, stdio: 'ignore' });
  return attachExit;
}
