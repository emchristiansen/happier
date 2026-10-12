import { filterEnvForSpawn } from './env_scope.mjs';

export function createLimaTestEnv(parentEnv = process.env) {
  // These shell fixtures run on the host, not in a VM. Inheriting stack or
  // provider settings can give a fixture access to the developer's live daemon.
  return {
    ...filterEnvForSpawn(parentEnv, { keepKeys: ['TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL'] }),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  };
}

// A real Lima guest has its own login files and PATH. Our process-boundary fake
// must not source the host's /etc/profile, which can restore the real Happier CLI
// ahead of fixture executables (including when the caller prefixes bash with env).
export const limaGuestExec = `
if [[ "\${1:-}" == "env" ]]; then
  shift
  while [[ "\${1:-}" == *=* ]]; do export "$1"; shift; done
fi
unset BASH_ENV ENV
if [[ "\${1:-}" != "bash" || ( "\${2:-}" != "-lc" && "\${2:-}" != "-c" && "\${2:-}" != "-s" ) ]]; then
  echo "unsupported fake Lima guest command: $*" >&2
  exit 2
fi
shift
if [[ "$1" == "-lc" ]]; then shift; set -- -c "$@"; fi
# Guest daemon process matching belongs to the VM's process namespace. These
# fixtures have no real guest processes and must never match host daemons.
pkill() { return 0; }
export -f pkill
exec /bin/bash --noprofile --norc "$@"
`;
