import { describe, expect, it } from 'vitest';

import { resolveDaemonServiceInstallConflictPlan } from './daemonInstallConflict';

describe('resolveDaemonServiceInstallConflictPlan', () => {
  it('does not treat the exact target as a duplicate when the only matching tuple is from another Happier home', () => {
    const exactTargetService = {
      serverId: 'default',
      name: 'Default background service',
      installed: true as const,
      path: '/home/alice/.config/systemd/user/happier-daemon.default.service',
      platform: 'linux' as const,
      mode: 'user' as const,
      happierHomeDir: '/home/alice/.happier',
      releaseChannel: 'preview' as const,
      label: 'happier-daemon.default',
      targetMode: 'default-following' as const,
    };
    const otherHomeService = {
      ...exactTargetService,
      path: '/home/bob/.config/systemd/user/happier-daemon.default.service',
      happierHomeDir: '/home/bob/.happier',
    };

    const plan = resolveDaemonServiceInstallConflictPlan({
      target: {
        platform: 'linux',
        mode: 'user',
        targetMode: 'default-following',
        ring: 'preview',
        instanceId: null,
        happierHomeDir: '/home/alice/.happier',
      },
      strategy: 'require-explicit',
      services: [exactTargetService, otherHomeService],
    });

    expect(plan.exactTargetExists).toBe(true);
    expect(plan.competingServices).toEqual([otherHomeService]);
    expect(plan.servicesToRemove).toEqual([]);
    expect(plan.foreignHomeConflicts).toEqual([otherHomeService]);
  });

  it('does not treat the exact target as converged when a same-home same-target duplicate still exists', () => {
    const exactTargetService = {
      serverId: 'default',
      name: 'Default background service',
      installed: true as const,
      path: '/home/alice/.config/systemd/user/happier-daemon.default.service',
      platform: 'linux' as const,
      mode: 'user' as const,
      happierHomeDir: '/home/alice/.happier',
      releaseChannel: 'preview' as const,
      label: 'happier-daemon.default',
      targetMode: 'default-following' as const,
    };
    const duplicateTargetService = {
      ...exactTargetService,
      path: '/home/alice/.config/systemd/user/happier-daemon.preview.default.service',
    };

    const plan = resolveDaemonServiceInstallConflictPlan({
      target: {
        platform: 'linux',
        mode: 'user',
        targetMode: 'default-following',
        ring: 'preview',
        instanceId: null,
        happierHomeDir: '/home/alice/.happier',
      },
      strategy: 'require-explicit',
      services: [exactTargetService, duplicateTargetService],
    });

    expect(plan.exactTargetExists).toBe(true);
    expect(plan.exactTargetIsConverged).toBe(false);
    expect(plan.competingServices).toEqual([exactTargetService, duplicateTargetService]);
    expect(plan.servicesToRemove).toEqual([]);
    expect(plan.foreignHomeConflicts).toEqual([]);
  });

  it('treats trailing slashes in happierHomeDir as the same home for conflict detection', () => {
    const existingService = {
      serverId: 'default',
      name: 'Default background service',
      installed: true as const,
      path: '/home/alice/.config/systemd/user/happier-daemon.default.service',
      platform: 'linux' as const,
      mode: 'user' as const,
      happierHomeDir: '/home/alice/.happier/',
      releaseChannel: 'preview' as const,
      label: 'happier-daemon.default',
      targetMode: 'default-following' as const,
    };

    const plan = resolveDaemonServiceInstallConflictPlan({
      target: {
        platform: 'linux',
        mode: 'user',
        targetMode: 'default-following',
        ring: 'preview',
        instanceId: null,
        happierHomeDir: '/home/alice/.happier',
      },
      strategy: 'require-explicit',
      services: [existingService],
    });

    expect(plan.exactTargetExists).toBe(true);
    expect(plan.foreignHomeConflicts).toEqual([]);
  });

  it('keeps replace-ring scoped to the target ring for default-following installs', () => {
    const previewService = {
      serverId: 'default',
      name: 'Preview default background service',
      installed: true as const,
      path: '/home/alice/.config/systemd/user/happier-daemon.preview.default.service',
      platform: 'linux' as const,
      mode: 'user' as const,
      happierHomeDir: '/home/alice/.happier',
      releaseChannel: 'preview' as const,
      label: 'happier-daemon.preview.default',
      targetMode: 'default-following' as const,
    };
    const stableService = {
      ...previewService,
      path: '/home/alice/.config/systemd/user/happier-daemon.default.service',
      releaseChannel: 'stable' as const,
      label: 'happier-daemon.default',
    };

    const plan = resolveDaemonServiceInstallConflictPlan({
      target: {
        platform: 'linux',
        mode: 'user',
        targetMode: 'default-following',
        ring: 'preview',
        instanceId: null,
        happierHomeDir: '/home/alice/.happier',
      },
      strategy: 'replace-ring',
      services: [previewService, stableService],
    });

    expect(plan.competingServices).toEqual([stableService]);
    expect(plan.servicesToRemove).toEqual([]);
  });

  it('lets replace-all remove a same-mode default-following service from another Happier home', () => {
    const staleDefaultService = {
      serverId: 'default',
      name: 'Default background service',
      installed: true as const,
      path: '/Users/alice/Library/LaunchAgents/com.happier.cli.daemon.default.plist',
      platform: 'darwin' as const,
      mode: 'user' as const,
      happierHomeDir: '/Users/alice/.happier/stacks/repo-dev-old/cli',
      releaseChannel: 'stable' as const,
      label: 'com.happier.cli.daemon.default',
      targetMode: 'default-following' as const,
    };

    const plan = resolveDaemonServiceInstallConflictPlan({
      target: {
        platform: 'darwin',
        mode: 'user',
        targetMode: 'default-following',
        ring: 'publicdev',
        instanceId: null,
        happierHomeDir: '/Users/alice/.happier',
      },
      strategy: 'replace-all',
      services: [staleDefaultService],
    });

    expect(plan.competingServices).toEqual([staleDefaultService]);
    expect(plan.foreignHomeConflicts).toEqual([]);
    expect(plan.servicesToRemove).toEqual([staleDefaultService]);
    expect(plan.exactTargetIsConverged).toBe(false);
  });

  it('keeps replace-all blocked for same-instance pinned services from another Happier home', () => {
    const pinnedService = {
      serverId: 'company',
      name: 'Company',
      installed: true as const,
      path: '/Users/alice/Library/LaunchAgents/com.happier.cli.daemon.company.plist',
      platform: 'darwin' as const,
      mode: 'user' as const,
      happierHomeDir: '/Users/alice/.happier-other',
      releaseChannel: 'stable' as const,
      label: 'com.happier.cli.daemon.company',
      targetMode: 'pinned' as const,
    };

    const plan = resolveDaemonServiceInstallConflictPlan({
      target: {
        platform: 'darwin',
        mode: 'user',
        targetMode: 'pinned',
        ring: 'publicdev',
        instanceId: 'company',
        happierHomeDir: '/Users/alice/.happier',
      },
      strategy: 'replace-all',
      services: [pinnedService],
    });

    expect(plan.foreignHomeConflicts).toEqual([pinnedService]);
    expect(plan.servicesToRemove).toEqual([]);
  });
  describe('pinned targets on one release ring', () => {
    const home = '/home/alice/.happier';
    const pinnedTarget = {
      platform: 'linux' as const,
      mode: 'user' as const,
      targetMode: 'pinned' as const,
      ring: 'stable' as const,
      instanceId: 'company',
      activeServerId: 'company',
      serverUrl: 'https://company.example.test',
      happierHomeDir: home,
      defaultFollowingServer: null,
    };
    const pinnedService = (serverId: string, relayUrl: string) => ({
      serverId,
      activeServerId: serverId,
      name: serverId,
      relayUrl,
      installed: true as const,
      path: `/home/alice/.config/systemd/user/happier-daemon.${serverId}.service`,
      platform: 'linux' as const,
      mode: 'user' as const,
      happierHomeDir: home,
      releaseChannel: 'stable' as const,
      label: `happier-daemon.${serverId}`,
      targetMode: 'pinned' as const,
    });
    const defaultFollowingService = {
      serverId: 'default',
      name: 'Default automatic startup',
      relayUrl: null,
      installed: true as const,
      path: '/home/alice/.config/systemd/user/happier-daemon.default.service',
      platform: 'linux' as const,
      mode: 'user' as const,
      happierHomeDir: home,
      releaseChannel: 'stable' as const,
      label: 'happier-daemon.default',
      targetMode: 'default-following' as const,
    };

    it('lets a pinned service for another relay coexist with the target', () => {
      const personal = pinnedService('personal', 'https://personal.example.test');

      const plan = resolveDaemonServiceInstallConflictPlan({
        target: pinnedTarget,
        strategy: 'replace-ring',
        services: [personal],
      });

      expect(plan.competingServices).toEqual([]);
      expect(plan.servicesToRemove).toEqual([]);
    });

    it('still treats a pinned service for the same relay under another profile id as competing', () => {
      const alias = pinnedService('company-alias', 'https://COMPANY.example.test/');

      const plan = resolveDaemonServiceInstallConflictPlan({
        target: pinnedTarget,
        strategy: 'replace-ring',
        services: [alias],
      });

      expect(plan.competingServices).toEqual([alias]);
      expect(plan.servicesToRemove).toEqual([alias]);
    });

    it('lets the target coexist with the default-following service while that service serves another relay', () => {
      const plan = resolveDaemonServiceInstallConflictPlan({
        target: {
          ...pinnedTarget,
          defaultFollowingServer: { serverId: 'personal', serverUrl: 'https://personal.example.test' },
        },
        strategy: 'require-explicit',
        services: [defaultFollowingService],
      });

      expect(plan.competingServices).toEqual([]);
    });

    it('treats the default-following service as competing while it serves the target relay or its relay is unknown', () => {
      const servingTarget = resolveDaemonServiceInstallConflictPlan({
        target: {
          ...pinnedTarget,
          defaultFollowingServer: { serverId: 'company', serverUrl: 'https://company.example.test' },
        },
        strategy: 'require-explicit',
        services: [defaultFollowingService],
      });
      const unknownRelay = resolveDaemonServiceInstallConflictPlan({
        target: pinnedTarget,
        strategy: 'require-explicit',
        services: [defaultFollowingService],
      });

      expect(servingTarget.competingServices).toEqual([defaultFollowingService]);
      expect(unknownRelay.competingServices).toEqual([defaultFollowingService]);
    });
  });
});
