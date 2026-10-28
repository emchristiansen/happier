import type { PreflightSessionControlsProbeAdapter } from '@/capabilities/probes/preflightSessionControlsProbeAdapterTypes';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import {
  resolveOpenCodeCliLaunchSpec,
  type OpenCodeCliLaunchSpec,
} from '@/backends/opencode/utils/resolveOpenCodeCliCommand';
import { prepareOpenCodeConnectedAuthAssets } from '@/backends/opencode/brokerPlugin';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import { spawn } from 'node:child_process';

import { asRecord, normalizeString } from '../server/openCodeParsing';
import { isOpenCodeModelSelectable, modelSupportsReasoningVariants, parseOpenCodeModelId } from '../server/openCodeModelParsing';
import { buildOpenCodeThinkingModelOptionsFromVariants } from '../modelOptions/openCodeThinkingModelOption';
import { readContextWindowTokensFromModelRecord } from '@/backends/modelCapabilities/contextWindowTokens';

type OpenCodePreflightModelRecord = Readonly<{
  id?: string;
  providerID?: string;
  name?: string;
  family?: string;
  status?: string;
  capabilities?: unknown;
  variants?: unknown;
}>;

type OpenCodePreflightModelBlock = Readonly<{
  fullId: string;
  record: OpenCodePreflightModelRecord;
}>;

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractJsonBlockFromLines(lines: string[], startIndex: number): { jsonText: string; endIndexInclusive: number } | null {
  let depth = 0;
  let started = false;
  let jsonText = '';

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i] ?? '';
    jsonText += `${line}\n`;
    for (const ch of line) {
      if (ch === '{') {
        depth += 1;
        started = true;
      } else if (ch === '}') {
        depth -= 1;
      }
    }
    if (started && depth === 0) {
      return { jsonText, endIndexInclusive: i };
    }
  }

  return null;
}

function parseOpenCodeModelsVerboseOutput(outputRaw: string): OpenCodePreflightModelBlock[] | null {
  const output = typeof outputRaw === 'string' ? outputRaw : '';
  if (!output.trim()) return [];

  const lines = output.split('\n');
  const parsed: OpenCodePreflightModelBlock[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] ?? '').trim();
    if (!line) continue;

    const fullId = line;
    let cursor = i + 1;
    while (cursor < lines.length) {
      const next = String(lines[cursor] ?? '').trim();
      if (next === '') {
        cursor += 1;
        continue;
      }
      break;
    }
    if (cursor >= lines.length || !String(lines[cursor] ?? '').trim().startsWith('{')) continue;

    const block = extractJsonBlockFromLines(lines, cursor);
    if (!block) return null;

    const record = tryParseJsonObject(block.jsonText);
    if (!record) return null;

    const parsedId = parseOpenCodeModelId(fullId);
    if (
      !parsedId
      || parsedId.providerID !== normalizeString(record.providerID)
      || parsedId.modelID !== normalizeString(record.id)
    ) return null;

    parsed.push({ fullId, record });
    i = block.endIndexInclusive;
  }

  return parsed.length > 0 ? parsed : null;
}

function parseOpenCodeV2ModelsApiOutput(outputRaw: string): OpenCodePreflightModelBlock[] | null {
  const envelope = tryParseJsonObject(outputRaw.trim());
  if (!Array.isArray(envelope?.data)) return null;
  if (envelope.data.length === 0) return [];

  const parsed = envelope.data.flatMap((rawModel): OpenCodePreflightModelBlock[] => {
    const record = asRecord(rawModel);
    const providerID = normalizeString(record?.providerID);
    const modelID = normalizeString(record?.id);
    if (!record || !providerID || !modelID) return [];
    return [{ fullId: `${providerID}/${modelID}`, record }];
  });
  return parsed.length > 0 ? parsed : null;
}

function buildOpenCodePreflightModels(
  blocks: readonly OpenCodePreflightModelBlock[],
): unknown[] {
  const models = blocks
    .map((block) => {
      const record = block.record;
      const fullId = block.fullId;
      const model = parseOpenCodeModelId(fullId);
      if (!model || !isOpenCodeModelSelectable({ ...model, modelRecord: record })) return null;
      const name = normalizeString(record.name) || fullId;
      const description = normalizeString(record.family) || normalizeString(record.providerID) || undefined;
      const supportsReasoning = modelSupportsReasoningVariants(record);
      const contextWindowTokens = readContextWindowTokensFromModelRecord(record);
      const modelOptions = supportsReasoning
        ? buildOpenCodeThinkingModelOptionsFromVariants(record.variants, null)
        : null;
      return {
        id: fullId,
        name,
        ...(description ? { description } : {}),
        ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
        ...(modelOptions ? { modelOptions } : {}),
      };
    })
    .filter((model): model is NonNullable<typeof model> => model !== null);

  return models;
}

async function runOpenCodeModelsProbeCommand(params: Readonly<{
  cwd: string;
  timeoutMs: number;
  processEnv: NodeJS.ProcessEnv;
  launch: OpenCodeCliLaunchSpec;
  args: readonly string[];
  parseOutput: (stdout: string) => OpenCodePreflightModelBlock[] | null;
}>): Promise<unknown[] | null> {
  const timeoutMs = Math.max(1, params.timeoutMs);
  const command = params.launch.command;
  const args = [...params.launch.args, ...params.args];

  return await new Promise((resolve) => {
    let stdout = '';
    let settled = false;

    const finish = (result: unknown[] | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const invocation = resolveWindowsCommandInvocation({
      command,
      args,
      resolveCommandOnPath: true,
    });

    const child = spawn(invocation.command, invocation.args, {
      cwd: params.cwd,
      env: { ...params.processEnv, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });

    const timer = setTimeout(() => {
      if (process.platform === 'win32') {
        void killProcessTree(child, { graceMs: 250 }).catch(() => undefined);
      } else {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
      finish(null);
    }, timeoutMs);

    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
    }

    child.on('close', (code) => {
      clearTimeout(timer);
      if (typeof code !== 'number' || code !== 0) return finish(null);

      const blocks = params.parseOutput(stdout);
      if (!blocks) return finish(null);
      finish(buildOpenCodePreflightModels(blocks));
    });
  });
}

export const openCodePreflightModelsProbeAdapter: PreflightSessionControlsProbeAdapter = {
  connectedServiceAuth: 'materialized-env',
  failureCacheStrategy: 'cooldown',
  probeModelsRaw: async ({ cwd, timeoutMs, processEnv }) => {
    const deadlineMs = Date.now() + Math.max(1, timeoutMs);
    const baseEnv = processEnv ?? process.env;
    const launch = (() => {
      try {
        return resolveOpenCodeCliLaunchSpec(baseEnv);
      } catch {
        return null;
      }
    })();
    if (!launch) return null;
    const prepared = await prepareOpenCodeConnectedAuthAssets({
      env: baseEnv,
      apiGeneration: launch.apiGeneration,
    }).catch(() => null);
    if (!prepared) return null;
    const probeEnv = prepared.openCodeConfigContent === undefined
      ? baseEnv
      : { ...baseEnv, OPENCODE_CONFIG_CONTENT: prepared.openCodeConfigContent };
    const probe = async (
      args: readonly string[],
      parseOutput: (stdout: string) => OpenCodePreflightModelBlock[] | null,
    ): Promise<unknown[] | null> => {
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) return null;
      return await runOpenCodeModelsProbeCommand({
        cwd,
        timeoutMs: remainingMs,
        processEnv: probeEnv,
        launch,
        args,
        parseOutput,
      });
    };

    return await probe(
      ['api', 'get', '/api/model', '--standalone', '--param', `location[directory]=${cwd}`],
      parseOpenCodeV2ModelsApiOutput,
    ) ?? await probe(['models', '--verbose'], parseOpenCodeModelsVerboseOutput);
  },
};
