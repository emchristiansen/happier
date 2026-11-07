import { parseArgs } from 'node:util';

import type { CommandContext } from '@/cli/commandRegistry';
import { authenticateAcpAgent } from '@/agent/acp/authenticateAcpAgent';
import { ensureAgyAcpServerForLaunch } from '../acp/ensureAgyAcpServerForLaunch';

export async function handleAgyCliCommand(context: CommandContext): Promise<void> {
  if (context.args[1] !== 'auth') {
    const { handleCatalogDefinedAcpCliCommand } = await import('@/agent/acp/catalog/handleCatalogDefinedAcpCliCommand');
    await handleCatalogDefinedAcpCliCommand('agy', context);
    return;
  }

  const action = context.args[2];
  if (!action || ['help', '--help', '-h'].includes(action) || context.args.includes('--help')) {
    console.log('happier agy auth login [--method <oauth-personal|oauth-business|gemini-api-key|agent-platform>]');
    return;
  }
  if (action !== 'login') throw new Error('Unknown AGY auth command. Run "happier agy auth --help".');
  const { values } = parseArgs({
    args: context.args.slice(3),
    options: { method: { type: 'string', default: 'oauth-personal' } },
    strict: true,
  });

  const controller = new AbortController();
  const onInterrupt = () => controller.abort(new DOMException('AGY login cancelled', 'AbortError'));
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);
  try {
    const launch = await ensureAgyAcpServerForLaunch();
    console.log('Signing in to the Antigravity ACP server. Follow its browser login link if requested.');
    await authenticateAcpAgent({
      ...launch,
      agentName: 'agy',
      cwd: process.cwd(),
      env: process.env,
      methodId: values.method ?? 'oauth-personal',
      signal: controller.signal,
      onStderr: (text) => { process.stderr.write(text); },
    });
    console.log('Antigravity ACP login completed. You can now start a Happier AGY session.');
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
  }
}
