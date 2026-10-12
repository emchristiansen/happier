import { describe, expect, it } from 'vitest';

import { planDaemonServiceInstall } from './plan';

/**
 * The autostart dimension: users must be able to keep the background service
 * installed while stopping it from starting at login, so the daemon only runs
 * while something (the desktop app, or an explicit `happier service start`)
 * asks for it.
 *
 * Every assertion here is plan-level: it inspects the definition file content
 * and the command list the installer would execute. None of it executes
 * launchctl/systemctl/schtasks.
 */

const DARWIN_BASE = {
  platform: 'darwin',
  channel: 'stable',
  instanceId: 'cloud',
  activeServerId: 'cloud',
  uid: 501,
  userHomeDir: '/Users/test',
  happierHomeDir: '/Users/test/.happier',
  serverUrl: 'https://api.happier.dev',
  webappUrl: 'https://app.happier.dev',
  publicServerUrl: 'https://api.happier.dev',
  nodePath: '/opt/homebrew/bin/node',
  entryPath: '/usr/local/lib/node_modules/@happier-dev/cli/dist/index.mjs',
} as const;

const LINUX_BASE = {
  platform: 'linux',
  mode: 'user',
  channel: 'stable',
  instanceId: 'cloud',
  activeServerId: 'cloud',
  userHomeDir: '/home/test',
  happierHomeDir: '/home/test/.happier',
  serverUrl: 'https://api.happier.dev',
  webappUrl: 'https://app.happier.dev',
  publicServerUrl: 'https://api.happier.dev',
  nodePath: '/usr/bin/node',
  entryPath: '/usr/lib/node_modules/@happier-dev/cli/dist/index.mjs',
} as const;

const WIN32_BASE = {
  platform: 'win32',
  channel: 'stable',
  instanceId: 'cloud',
  activeServerId: 'cloud',
  userHomeDir: 'C:\\Users\\test',
  happierHomeDir: 'C:\\Users\\test\\.happier',
  serverUrl: 'https://api.happier.dev',
  webappUrl: 'https://app.happier.dev',
  publicServerUrl: 'https://api.happier.dev',
  nodePath: 'C:\\Users\\test\\.local\\bin\\happier.exe',
  entryPath: '',
} as const;

function commandLines(plan: { commands: readonly { cmd: string; args: readonly string[] }[] }): string[] {
  return plan.commands.map((c) => `${c.cmd} ${c.args.join(' ')}`);
}

describe('daemon service install plan — autostart dimension', () => {
  describe('darwin (launchd)', () => {
    it('omits the login trigger in on-demand mode', () => {
      const plan = planDaemonServiceInstall({ ...DARWIN_BASE, autostart: 'on-demand' });
      const content = plan.files[0]?.content ?? '';

      expect(content).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
      expect(content).not.toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
      // launchd.plist(5) on KeepAlive/SuccessfulExit: "This key implies that RunAtLoad is set to
      // true, since the job needs to run at least once before we can get an exit status." So a
      // KeepAlive dict would re-arm the login start this mode exists to remove.
      expect(content).not.toMatch(/KeepAlive/);
      // Installed, and started right now — just not at the next login.
      expect(commandLines(plan)).toContain('launchctl bootstrap gui/501 /Users/test/Library/LaunchAgents/com.happier.cli.daemon.cloud.plist');
      expect(commandLines(plan)).toContain('launchctl kickstart -k gui/501/com.happier.cli.daemon.cloud');
      // `launchctl enable` is retained on purpose: it is launchd's allow-flag,
      // not a login trigger. Uninstall runs `launchctl disable` (see
      // planDaemonServiceUninstall), so dropping `enable` here would make
      // reinstall-after-uninstall fail at `bootstrap` and would leave an
      // on-demand service unstartable. `RunAtLoad` above is the login trigger.
      expect(commandLines(plan)).toContain('launchctl enable gui/501/com.happier.cli.daemon.cloud');
    });

    it('retains the login trigger by default', () => {
      const plan = planDaemonServiceInstall({ ...DARWIN_BASE });
      const content = plan.files[0]?.content ?? '';

      expect(content).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
      // An at-login service is meant to be there whenever the user is logged in, so launchd
      // restarts it after a crash.
      expect(content).toMatch(/<key>KeepAlive<\/key>/);
      expect(commandLines(plan)).toContain('launchctl enable gui/501/com.happier.cli.daemon.cloud');
    });
  });

  describe('linux (systemd)', () => {
    it('does not enable the unit in on-demand mode, and clears a previously enabled login trigger', () => {
      const plan = planDaemonServiceInstall({ ...LINUX_BASE, autostart: 'on-demand' });
      const lines = commandLines(plan);

      expect(lines).not.toContain('systemctl --user enable happier-daemon.cloud.service');
      expect(lines).toContain('systemctl --user disable happier-daemon.cloud.service');
      // Still running now: `disable` without `--now` leaves the unit alone.
      expect(lines).toContain('systemctl --user restart happier-daemon.cloud.service');
      expect(lines.indexOf('systemctl --user disable happier-daemon.cloud.service'))
        .toBeLessThan(lines.indexOf('systemctl --user restart happier-daemon.cloud.service'));
    });

    it('enables the unit by default', () => {
      const lines = commandLines(planDaemonServiceInstall({ ...LINUX_BASE }));

      expect(lines).toContain('systemctl --user enable happier-daemon.cloud.service');
      expect(lines).not.toContain('systemctl --user disable happier-daemon.cloud.service');
    });

    it('does not enable a system-mode unit in on-demand mode', () => {
      const lines = commandLines(planDaemonServiceInstall({
        ...LINUX_BASE,
        mode: 'system',
        systemUser: 'happier',
        autostart: 'on-demand',
      }));

      expect(lines).not.toContain('systemctl enable happier-daemon.cloud.service');
      expect(lines).toContain('systemctl disable happier-daemon.cloud.service');
    });
  });

  describe('win32 (scheduled task)', () => {
    it('registers an interactive user task without triggers in on-demand mode', () => {
      const install = planDaemonServiceInstall({ ...WIN32_BASE, autostart: 'on-demand' })
        .commands.find((command) => command.cmd === 'powershell.exe' && String(command.args.at(-1)).includes('RegisterTask'));
      const registration = String(install?.args.at(-1) ?? '');
      expect(registration).toContain('<Triggers/>');
      expect(registration).toContain('<LogonType>InteractiveToken</LogonType>');
      expect(registration).not.toContain('LogonTrigger');
      // Installed and started right now, just never by the scheduler.
      expect(commandLines(planDaemonServiceInstall({ ...WIN32_BASE, autostart: 'on-demand' })))
        .toContain('schtasks /Run /TN Happier\\happier-daemon.cloud');
    });

    it('registers a current-user logon trigger by default', () => {
      const install = planDaemonServiceInstall({ ...WIN32_BASE })
        .commands.find((command) => command.cmd === 'powershell.exe' && String(command.args.at(-1)).includes('RegisterTask'));
      const registration = String(install?.args.at(-1) ?? '');
      expect(registration).toContain('<LogonTrigger>');
      expect(registration).toContain('$xml.Task.Triggers.LogonTrigger.UserId = $userId');
      expect(registration).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    });
  });

  describe('installed definition records the mode', () => {
    // Without this, switching modes on an already-installed service is a silent
    // no-op: installDaemonService returns early when the installed definition
    // matches the expected one (installer.ts), and on Linux/Windows the login
    // trigger lives outside the definition file.
    it('writes the selected mode into the service definition on every platform', () => {
      expect(planDaemonServiceInstall({ ...DARWIN_BASE, autostart: 'on-demand' }).files[0]?.content ?? '')
        .toContain('<key>HAPPIER_DAEMON_SERVICE_AUTOSTART</key>');
      expect(planDaemonServiceInstall({ ...DARWIN_BASE, autostart: 'on-demand' }).files[0]?.content ?? '')
        .toContain('<string>on-demand</string>');
      expect(planDaemonServiceInstall({ ...DARWIN_BASE }).files[0]?.content ?? '')
        .toContain('<string>at-login</string>');

      expect(planDaemonServiceInstall({ ...LINUX_BASE, autostart: 'on-demand' }).files[0]?.content ?? '')
        .toContain('Environment=HAPPIER_DAEMON_SERVICE_AUTOSTART=on-demand');
      expect(planDaemonServiceInstall({ ...LINUX_BASE }).files[0]?.content ?? '')
        .toContain('Environment=HAPPIER_DAEMON_SERVICE_AUTOSTART=at-login');

      expect(planDaemonServiceInstall({ ...WIN32_BASE, autostart: 'on-demand' }).files[0]?.content ?? '')
        .toContain('HAPPIER_DAEMON_SERVICE_AUTOSTART');
    });
  });
});
