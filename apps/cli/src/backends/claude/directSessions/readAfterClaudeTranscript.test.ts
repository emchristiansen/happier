import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readAfterClaudeTranscript } from './readAfterClaudeTranscript';
import { encodeClaudeDirectForwardCursor } from './claudeDirectForwardCursor';

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe('readAfterClaudeTranscript', () => {
  it.each(['items', 'bytes', 'internal-only'] as const)('reports a %s page limit without changing the released truncation boolean', async (limit) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-direct-after-'));
    const configDir = join(root, '.claude');
    const sessionFile = join(configDir, 'projects', 'proj-a', 'sess-1.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-a'), { recursive: true });
    const first = jsonlLine(limit === 'internal-only' ? { type: 'progress' } : { type: 'user', uuid: 'u1', message: { content: 'first' } });
    await writeFile(sessionFile, first + jsonlLine({ type: 'user', uuid: 'u2', message: { content: 'second' } }), 'utf8');
    const params = { source: { kind: 'claudeConfig' as const, configDir, projectId: 'proj-a' }, env: {}, remoteSessionId: 'sess-1', maxBytes: limit === 'bytes' ? Buffer.byteLength(first) : 1024, maxItems: limit === 'bytes' ? 10 : 1 };
    const cursor = encodeClaudeDirectForwardCursor({ v: 1, kind: 'claudeForward', fileRelPath: 'projects/proj-a/sess-1.jsonl', offsetBytes: 0 });

    const page = await readAfterClaudeTranscript({ ...params, cursor });
    expect(page).toMatchObject({ truncated: false, truncationReason: 'page_limit' });
    expect(page.items).toHaveLength(limit === 'internal-only' ? 0 : 1);
    const next = await readAfterClaudeTranscript({ ...params, cursor: page.nextCursor! });
    expect(next.items.map((item) => item.raw)).toEqual([{ role: 'user', content: { type: 'text', text: 'second' } }]);
    expect(next.truncationReason).toBeUndefined();
  });

  it.each(['tail', 'different-file', 'shrunk-file'] as const)('preserves a partial terminal line when capturing a %s cursor', async (capture) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-direct-after-'));
    const configDir = join(root, '.claude');
    const sessionFile = join(configDir, 'projects', 'proj-a', 'sess-1.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-a'), { recursive: true });
    const pending = JSON.stringify({ type: 'user', uuid: 'u2', message: { content: 'completed after capture' } });
    await writeFile(sessionFile, jsonlLine({ type: 'user', uuid: 'u1', message: { content: 'before' } }) + pending.slice(0, -1), 'utf8');
    const params = { source: { kind: 'claudeConfig' as const, configDir, projectId: 'proj-a' }, env: {}, remoteSessionId: 'sess-1', maxBytes: 1024, maxItems: 10 };
    const cursor = capture === 'tail' ? 'tail' : encodeClaudeDirectForwardCursor({ v: 1, kind: 'claudeForward', fileRelPath: capture === 'different-file' ? 'projects/other.jsonl' : 'projects/proj-a/sess-1.jsonl', offsetBytes: 100_000 });
    const captured = await readAfterClaudeTranscript({ ...params, cursor });
    expect(captured.truncated).toBe(capture !== 'tail');
    expect(captured.nextCursor).toBeTruthy();
    await appendFile(sessionFile, pending.slice(-1) + '\n', 'utf8');

    const followed = await readAfterClaudeTranscript({ ...params, cursor: captured.nextCursor! });
    expect(followed.items.map((item) => item.raw)).toEqual([{ role: 'user', content: { type: 'text', text: 'completed after capture' } }]);
  });

  it('supports tail cursors and waits for full lines before parsing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-direct-after-'));
    const configDir = join(root, '.claude');
    const sessionFile = join(configDir, 'projects', 'proj-a', 'sess-1.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-a'), { recursive: true });

    await writeFile(sessionFile, jsonlLine({ type: 'user', uuid: 'u1', message: { content: 'hello' } }), 'utf8');

    const tail = await readAfterClaudeTranscript({
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-a' },
      env: {} as NodeJS.ProcessEnv,
      remoteSessionId: 'sess-1',
      cursor: 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(tail.items).toHaveLength(0);
    expect(tail.nextCursor).toBeTruthy();
    expect(tail.truncated).toBe(false);

    const fullLine = JSON.stringify({ type: 'assistant', uuid: 'a2', message: { model: 'm', content: [{ type: 'text', text: 'ok' }] } });
    await appendFile(sessionFile, fullLine.slice(0, -1), 'utf8'); // partial JSON, no newline

    const afterPartial = await readAfterClaudeTranscript({
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-a' },
      env: {} as NodeJS.ProcessEnv,
      remoteSessionId: 'sess-1',
      cursor: tail.nextCursor ?? 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(afterPartial.items).toHaveLength(0);
    expect(afterPartial.truncated).toBe(false);
    expect(afterPartial.truncationReason).toBeUndefined();
    expect(afterPartial.nextCursor).toBeTruthy();

    await appendFile(sessionFile, `${fullLine.slice(-1)}\n`, 'utf8');

    const afterFull = await readAfterClaudeTranscript({
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-a' },
      env: {} as NodeJS.ProcessEnv,
      remoteSessionId: 'sess-1',
      cursor: afterPartial.nextCursor ?? 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(afterFull.items).toHaveLength(1);
    expect((afterFull.items[0]?.raw as any)?.role).toBe('agent');
    expect((((afterFull.items[0]?.raw as any)?.content as any)?.data as any)?.message?.role).toBe('assistant');
    expect(afterFull.nextCursor).toBeTruthy();
    expect(afterFull.truncated).toBe(false);
  });

  it('returns truncated=true for invalid cursors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-direct-after-bad-'));
    const configDir = join(root, '.claude');
    const sessionFile = join(configDir, 'projects', 'proj-a', 'sess-1.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-a'), { recursive: true });
    await writeFile(sessionFile, jsonlLine({ type: 'user', uuid: 'u1', message: { content: 'hello' } }), 'utf8');

    const res = await readAfterClaudeTranscript({
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-a' },
      env: {} as NodeJS.ProcessEnv,
      remoteSessionId: 'sess-1',
      cursor: 'not-a-valid-cursor',
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(res.items).toHaveLength(0);
    expect(res.truncated).toBe(true);
    expect(res).toMatchObject({ truncationReason: 'source_discontinuity' });
  });
});
