import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runCommandStreaming } from '../../process/index.js';

import { createScpReadyPayloadCopy } from './createScpReadyPayloadCopy.js';

export async function createScpReadyPayloadArchive(payloadRoot: string): Promise<Readonly<{
  archiveStageRoot: string;
  archiveFileName: string;
  extractedPayloadDirName: string;
  cleanup: () => Promise<void>;
}>> {
  const scpReadyPayload = await createScpReadyPayloadCopy(payloadRoot);
  const archiveStageRoot = await mkdtemp(join(tmpdir(), 'happier-first-party-scp-archive-'));
  const extractedPayloadDirName = basename(scpReadyPayload.payloadRoot);
  const archiveFileName = `${extractedPayloadDirName}.tar`;

  try {
    await runCommandStreaming({ cmd: 'tar', args: [
      '-cf',
      join(archiveStageRoot, archiveFileName),
      '-C',
      join(scpReadyPayload.payloadRoot, '..'),
      extractedPayloadDirName,
    ] });
    return {
      archiveStageRoot,
      archiveFileName,
      extractedPayloadDirName,
      cleanup: async () => {
        await Promise.all([
          scpReadyPayload.cleanup(),
          rm(archiveStageRoot, { recursive: true, force: true }),
        ]);
      },
    };
  } catch (error) {
    await Promise.all([
      scpReadyPayload.cleanup(),
      rm(archiveStageRoot, { recursive: true, force: true }),
    ]);
    throw error;
  }
}
