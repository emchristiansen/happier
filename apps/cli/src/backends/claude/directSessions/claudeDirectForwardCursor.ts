import { readJsonlFileBackwardPage } from '@/api/directSessions/filePaging/jsonlBackwardPager';

type ClaudeForwardCursorV1 = Readonly<{
  v: 1;
  kind: 'claudeForward';
  fileRelPath: string;
  offsetBytes: number;
}>;

export function encodeClaudeDirectForwardCursor(value: ClaudeForwardCursorV1): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function encodeClaudeDirectTailCursor(params: Readonly<{ fileRelPath: string; offsetBytes: number | null }>): string {
  if (params.offsetBytes === null) {
    throw new Error('Cannot establish Claude transcript tail boundary within the JSONL read budget');
  }
  return encodeClaudeDirectForwardCursor({ v: 1, kind: 'claudeForward', fileRelPath: params.fileRelPath, offsetBytes: params.offsetBytes });
}

export async function readClaudeDirectTailCursor(params: Readonly<{
  filePath: string;
  fileRelPath: string;
  maxBytes: number;
  endOffsetBytes?: number;
}>): Promise<string> {
  const page = await readJsonlFileBackwardPage({
    filePath: params.filePath,
    endOffsetBytes: params.endOffsetBytes ?? null,
    maxBytes: params.maxBytes,
    maxItems: 1,
  });
  return encodeClaudeDirectTailCursor({ fileRelPath: params.fileRelPath, offsetBytes: page.tailOffsetBytes });
}

export function decodeClaudeDirectForwardCursor(raw: string): ClaudeForwardCursorV1 | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (record.v !== 1 || record.kind !== 'claudeForward') return null;
    const fileRelPath = typeof record.fileRelPath === 'string' ? record.fileRelPath : '';
    const offsetBytes = typeof record.offsetBytes === 'number' && Number.isFinite(record.offsetBytes) ? Math.trunc(record.offsetBytes) : NaN;
    if (!fileRelPath.trim()) return null;
    if (!Number.isFinite(offsetBytes) || offsetBytes < 0) return null;
    return { v: 1, kind: 'claudeForward', fileRelPath, offsetBytes };
  } catch {
    return null;
  }
}
