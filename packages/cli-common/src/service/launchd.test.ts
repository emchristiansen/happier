import { describe, expect, it } from 'vitest';

import { buildLaunchdPlistXml } from './launchd';

const BASE = {
  label: 'com.happier.cli.daemon.company',
  programArgs: ['/usr/local/bin/happier', 'daemon', 'start-sync'],
  stdoutPath: '/tmp/out.log',
  stderrPath: '/tmp/err.log',
};

describe('buildLaunchdPlistXml', () => {
  it('attributes the job to the apps it names, escaped, so Login Items shows the app', () => {
    const xml = buildLaunchdPlistXml({ ...BASE, associatedBundleIdentifiers: ['dev.happier.app', 'a&b'] });
    expect(xml).toContain('<key>AssociatedBundleIdentifiers</key>\n    <array>\n      <string>dev.happier.app</string>\n      <string>a&amp;b</string>\n    </array>');
  });

  it('writes no attribution when none is given', () => {
    expect(buildLaunchdPlistXml(BASE)).not.toContain('AssociatedBundleIdentifiers');
    expect(buildLaunchdPlistXml({ ...BASE, associatedBundleIdentifiers: [] })).not.toContain('AssociatedBundleIdentifiers');
  });
});
