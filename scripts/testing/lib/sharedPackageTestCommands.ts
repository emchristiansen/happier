import type { CommandSuiteEntry } from './runCommandSuite.ts';

/** Package-level checks that do not own a dedicated CI job. */
export const SHARED_PACKAGE_TEST_COMMANDS = [
  { id: 'privacy-kit:test', args: ['workspace', 'privacy-kit', 'test'] },
  { id: 'privacy-kit:bun', args: ['workspace', 'privacy-kit', 'test:runtime:bun'] },
  { id: 'protocol', args: ['workspace', '@happier-dev/protocol', 'test'] },
  { id: 'transfers', args: ['workspace', '@happier-dev/transfers', 'test'] },
  { id: 'sherpa-native', args: ['workspace', '@happier-dev/sherpa-native', 'test'] },
  { id: 'agents', args: ['workspace', '@happier-dev/agents', 'test'] },
  { id: 'cli-common', args: ['workspace', '@happier-dev/cli-common', 'test'] },
  { id: 'release-runtime', args: ['workspace', '@happier-dev/release-runtime', 'test'] },
  { id: 'connection-supervisor', args: ['workspace', '@happier-dev/connection-supervisor', 'test'] },
  { id: 'bootstrap', args: ['workspace', '@happier-dev/bootstrap', 'test'] },
  { id: 'docs:test', args: ['workspace', 'docs', 'test'] },
  { id: 'docs:content', args: ['workspace', 'docs', 'check:content'] },
  { id: 'website', args: ['workspace', '@happier-dev/website', 'test'] },
  { id: 'relay-server', args: ['--cwd', 'packages/relay-server', 'test'] },
] as const satisfies readonly CommandSuiteEntry[];
