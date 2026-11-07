import { spawnProc } from '../proc/proc.mjs';
import { buildRemoteDoctorCommand } from './remote_commands.mjs';
import { DEV_TARGET_SOURCE_REPO, loadSiblingMutagenOwner } from './mutagen_project.mjs';

async function defaultRunProcess({ label, command, args, env }) {
  const child = spawnProc(label, command, args, env, { silent: true });
  return child.completion;
}

function processResult(result) {
  return {
    ok: result?.code === 0,
    code: result?.code ?? null,
    ...(result?.error?.code ? { errorCode: result.error.code } : {}),
  };
}

export async function runDevTargetsDoctor(
  { targets, stackBaseDir, sourceDir = DEV_TARGET_SOURCE_REPO, env = process.env },
  { runProcess = defaultRunProcess } = {},
) {
  const siblingOwner = await loadSiblingMutagenOwner(sourceDir);
  const mutagenEnv = siblingOwner
    ? siblingOwner.resolveRuntime({ stackBaseDir: stackBaseDir ?? sourceDir, sourceDir, env }).env
    : env;
  const mutagen = processResult(
    await runProcess({
      label: 'mutagen',
      command: 'mutagen',
      args: ['version'],
      env: mutagenEnv,
    }),
  );
  const targetResults = [];
  for (const target of targets) {
    const sshArgs = [
      ...(target.sshConfigFile ? ['-F', target.sshConfigFile] : []),
      '-o',
      'ControlMaster=no',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      target.ssh,
      buildRemoteDoctorCommand(target),
    ];
    targetResults.push({
      name: target.name,
      platform: target.platform,
      ssh: target.ssh,
      ...processResult(
        await runProcess({
          label: `remote:${target.name}`,
          command: 'ssh',
          args: sshArgs,
          env,
        }),
      ),
    });
  }
  return {
    ok: mutagen.ok && targetResults.every((target) => target.ok),
    mutagen,
    targets: targetResults,
  };
}
