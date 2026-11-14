import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { Metadata } from '@/api/types';

import type { Session } from '../session';
import type { RawJSONLines } from '../types';
import { createSessionScanner } from '../utils/sessionScanner';
import { getProjectPath } from '../utils/path';
import { createClaudeSessionTranscriptProjector } from './createClaudeSessionTranscriptProjector';
import { wireClaudeWorkflowActivitySource } from '../workflows/wireClaudeWorkflowActivitySource';

// Quota delivery is the only replaced boundary: the scanner, projector and mapper are real.
const recordQuota = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
vi.mock('../connectedServices/surfaceClaudeRuntimeIssues', async (importOriginal) => ({
  ...await importOriginal<typeof import('../connectedServices/surfaceClaudeRuntimeIssues')>(),
  recordClaudeRateLimitQuotaEvidence: recordQuota,
}));

// INTEGRATION (plan H7): the native Claude `/goal` signal is a `goal_status`
// transcript ATTACHMENT. The session scanner DELIBERATELY drops `attachment`
// records before `onMessage` (`isClaudeInternalTranscriptMessage` → true for
// `type:'attachment'`, the F2 "keep attachments out of the visible transcript"
// gate). They survive ONLY on the scanner's RAW channel (`onRawJsonlValue`).
//
// The unit tests for the goal source / projector feed `observe()` directly and
// therefore never exercise the scanner drop — they passed while the real path
// was DEAD. This suite drives the REAL chokepoint: a temp Claude transcript
// JSONL → `createSessionScanner` → (post-strip `onMessage` + raw `onRawJsonlValue`)
// → the SHARED transcript projector → metadata, exactly as every launcher wires
// it. It is the regression guard for the raw-channel goal wiring.

async function waitFor(predicate: () => boolean, timeoutMs = 3000, intervalMs = 25): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition');
}

function createSessionFixture(claudeSessionId: string): Readonly<{
  session: Session;
  getMetadata: () => Metadata;
}> {
  let metadata: Metadata = {} as Metadata;
  const session = {
    sessionId: claudeSessionId,
    client: {
      sessionId: 'happy-session-id',
      sendClaudeSessionMessage: vi.fn(),
      sendClaudeSessionMessageCommittedExact: vi.fn(async () => {}),
      sendSessionEvent: vi.fn(),
      updateMetadata: (updater: (current: Metadata) => Metadata) => {
        metadata = updater(metadata);
      },
    },
  } as unknown as Session;
  return {
    session,
    getMetadata: () => metadata,
  };
}

function readGoalItem(metadata: Metadata): Record<string, unknown> | null {
  const workState = (metadata as Record<string, unknown>).sessionWorkStateV1 as
    | { items?: unknown[] }
    | undefined;
  const items = Array.isArray(workState?.items) ? workState.items : [];
  return (items.find(
    (item) => (item as Record<string, unknown>)?.id === 'goal:claude',
  ) as Record<string, unknown> | undefined) ?? null;
}

function readVisibleTranscriptTypes(session: Session): string[] {
  const send = session.client.sendClaudeSessionMessage as unknown as { mock: { calls: unknown[][] } };
  return send.mock.calls.flatMap((call) => {
    const message = call[0] as Record<string, unknown> | undefined;
    return message && typeof message.type === 'string' ? [message.type] : [];
  });
}

describe('Claude goal source — scanner raw-channel integration (H7)', () => {
  let testDir: string;
  let projectDir: string;
  let scanner: Awaited<ReturnType<typeof createSessionScanner>> | null = null;
  let originalClaudeConfigDir: string | undefined;

  beforeEach(async () => {
    testDir = join(tmpdir(), `goal-source-raw-channel-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(testDir, 'claude-config');
    projectDir = getProjectPath(testDir);
    await mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    if (scanner) {
      await scanner.cleanup();
      scanner = null;
    }
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  async function wireScannerToProjector(params: Readonly<{
    claudeSessionId: string;
    fixture: ReturnType<typeof createSessionFixture>;
  }>): Promise<void> {
    const projector = createClaudeSessionTranscriptProjector({
      session: params.fixture.session,
      logPrefix: '[integration]',
    });
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      // EXACTLY how a launcher wires it: the post-strip transcript path drives the
      // visible-transcript projector; the raw channel (which preserves attachments)
      // drives the goal source.
      onMessage: (message) => projector.observe(message),
      onRawJsonlValue: (value, observation) => projector.observeRaw(value, observation),
    });
  }

  it('derives an active goal work-state item from a goal_status attachment read off the scanner raw channel', async () => {
    const claudeSessionId = 'integration-claude-session-active';
    const fixture = createSessionFixture(claudeSessionId);
    await wireScannerToProjector({ claudeSessionId, fixture });

    const sessionFile = join(projectDir, `${claudeSessionId}.jsonl`);
    const lines = [
      { type: 'user', uuid: 'u1', sessionId: claudeSessionId, message: { role: 'user', content: 'go' } },
      {
        type: 'attachment',
        uuid: 'goal-attachment-1',
        sessionId: claudeSessionId,
        timestamp: '2026-06-24T00:00:00.000Z',
        attachment: { type: 'goal_status', met: false, condition: 'ship the goal feature' },
      },
    ];
    await writeFile(sessionFile, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    scanner!.onNewSession(claudeSessionId);

    await waitFor(() => readGoalItem(fixture.getMetadata()) !== null);

    expect(readGoalItem(fixture.getMetadata())).toMatchObject({
      id: 'goal:claude',
      kind: 'goal',
      status: 'active',
      title: 'ship the goal feature',
    });

    // F2 guard: the goal_status attachment must STILL be kept out of the visible
    // transcript even though the goal source observed it on the raw channel.
    expect(readVisibleTranscriptTypes(fixture.session)).not.toContain('attachment');
  });

  it('ingests a rate_limit_event row read off the scanner raw channel as quota evidence with its own capture time, never as visible transcript (HPI-30)', async () => {
    recordQuota.mockClear();
    const claudeSessionId = 'integration-claude-session-quota';
    const fixture = createSessionFixture(claudeSessionId);
    await wireScannerToProjector({ claudeSessionId, fixture });

    const sessionFile = join(projectDir, `${claudeSessionId}.jsonl`);
    const rateLimitRow = (uuid: string, timestamp: string) => ({
      type: 'rate_limit_event', uuid, sessionId: claudeSessionId, timestamp,
      rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: 1_782_000_000 } } },
    });
    const goalRow = (uuid: string, met: boolean) => ({
      type: 'attachment', uuid, sessionId: claudeSessionId, timestamp: '2026-06-24T00:00:00.000Z',
      attachment: { type: 'goal_status', met, condition: 'quota marker' },
    });
    // Rows present when the session is discovered are historical replay: not new quota evidence.
    await writeFile(sessionFile, [
      rateLimitRow('rl-historical', '2026-06-23T00:00:00.000Z'),
      goalRow('goal-active', false),
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');
    scanner!.onNewSession(claudeSessionId);
    await waitFor(() => readGoalItem(fixture.getMetadata())?.status === 'active');

    const capturedAt = '2026-06-24T00:00:00.000Z';
    await appendFile(sessionFile, [
      rateLimitRow('rl-live', capturedAt),
      // A later raw row proving ordered scanning reached past the live quota row.
      goalRow('goal-complete', true),
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');
    scanner!.onNewSession(claudeSessionId);
    await waitFor(() => readGoalItem(fixture.getMetadata())?.status === 'complete');

    expect(recordQuota).toHaveBeenCalledTimes(1);
    const [, windows, , capture] = recordQuota.mock.calls[0]!;
    expect(windows).toEqual([expect.objectContaining({ providerLimitId: 'five_hour' })]);
    expect(capture).toEqual({ providerCapturedAtMs: Date.parse(capturedAt) });
    expect(readVisibleTranscriptTypes(fixture.session)).not.toContain('rate_limit_event');
  });

  it('ingests a current quota row that falls in the reader\'s replay window, keyed to its own capture (HPI-30)', async () => {
    recordQuota.mockClear();
    const claudeSessionId = 'integration-claude-session-quota-first-live';
    const fixture = createSessionFixture(claudeSessionId);
    await wireScannerToProjector({ claudeSessionId, fixture });
    const sessionFile = join(projectDir, `${claudeSessionId}.jsonl`);
    const capturedAt = new Date(Date.now() - 1_000).toISOString();
    // Written before the reader's live boundary exists, so the scanner labels it historical replay.
    await writeFile(sessionFile, [
      {
        type: 'rate_limit_event', uuid: 'rl-first-live', sessionId: claudeSessionId, timestamp: capturedAt,
        rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: 1_782_000_000 } } },
      },
      { type: 'attachment', uuid: 'goal-marker', sessionId: claudeSessionId, timestamp: capturedAt, attachment: { type: 'goal_status', met: false, condition: 'marker' } },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');
    scanner!.onNewSession(claudeSessionId);
    await waitFor(() => readGoalItem(fixture.getMetadata())?.status === 'active');
    await waitFor(() => recordQuota.mock.calls.length > 0);
    expect(recordQuota).toHaveBeenCalledTimes(1);
    expect(recordQuota.mock.calls[0]![3]).toEqual({ providerCapturedAtMs: Date.parse(capturedAt), replayed: true });
    expect(readVisibleTranscriptTypes(fixture.session)).not.toContain('rate_limit_event');
  });

  it('records a quota row once when both the raw channel and a direct observe deliver it', async () => {
    recordQuota.mockClear();
    const fixture = createSessionFixture('integration-claude-session-quota-dedupe');
    const projector = createClaudeSessionTranscriptProjector({ session: fixture.session, logPrefix: '[integration]' });
    const row = {
      type: 'rate_limit_event', uuid: 'rl-once', timestamp: '2026-06-24T00:00:00.000Z',
      rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: 1_782_000_000 } } },
    };
    projector.observeRaw(row, { historicalReplay: false });
    await projector.observe(row as unknown as RawJSONLines);
    const other = { ...row, uuid: 'rl-other' };
    await projector.observe(other as unknown as RawJSONLines);
    expect(recordQuota).toHaveBeenCalledTimes(2);
  });

  it('transitions the goal to complete on a met:true goal_status attachment appended to the transcript', async () => {
    const claudeSessionId = 'integration-claude-session-complete';
    const fixture = createSessionFixture(claudeSessionId);
    await wireScannerToProjector({ claudeSessionId, fixture });

    const sessionFile = join(projectDir, `${claudeSessionId}.jsonl`);
    const lines = [
      {
        type: 'attachment',
        uuid: 'goal-attachment-active',
        sessionId: claudeSessionId,
        timestamp: '2026-06-24T00:00:00.000Z',
        attachment: { type: 'goal_status', met: false, condition: 'finish it' },
      },
      {
        type: 'attachment',
        uuid: 'goal-attachment-complete',
        sessionId: claudeSessionId,
        timestamp: '2026-06-24T00:01:00.000Z',
        attachment: { type: 'goal_status', met: true, condition: 'finish it' },
      },
    ];
    await writeFile(sessionFile, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    scanner!.onNewSession(claudeSessionId);

    await waitFor(() => readGoalItem(fixture.getMetadata())?.status === 'complete');

    expect(readGoalItem(fixture.getMetadata())).toMatchObject({ id: 'goal:claude', status: 'complete' });
  });

  it('does not treat workflow rows from the startup JSONL snapshot as live crash-recovery evidence', async () => {
    const claudeSessionId = 'integration-claude-session-workflow-replay';
    const sessionFile = join(projectDir, `${claudeSessionId}.jsonl`);
    await writeFile(sessionFile, `${JSON.stringify({
      type: 'assistant',
      session_id: claudeSessionId,
      uuid: 'uuid-toolu_replayed',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_replayed',
          name: 'Workflow',
          input: { script: "meta: { name: 'replayed workflow' }" },
        }],
      },
    })}\n`);
    let metadata = {
      sessionWorkflowActivityHeadlineV1: {
        v: 1,
        backendId: 'claude',
        updatedAt: 1_000,
        primaryRunId: 'toolu_replayed',
        activeRuns: [{
          runId: 'toolu_replayed',
          workflowToolUseId: 'toolu_replayed',
          title: 'replayed workflow',
          status: 'active',
          updatedAt: 1_000,
          recordRevision: '1',
          recordUpdatedAt: 1_000,
          totalAgents: 0,
          completedAgents: 0,
        }],
      },
    } as Metadata;
    const fixture = createSessionFixture(claudeSessionId);
    const workflowSource = wireClaudeWorkflowActivitySource({
      backendId: 'claude',
      startupReconcileGraceMs: 20,
      binding: {
        sessionId: 'happy-session-id',
        metadataWriter: {
          updateMetadata: (updater) => { metadata = updater(metadata); },
          getMetadataSnapshot: () => metadata,
        },
        upsertSystemRecord: async () => {},
        resolveEncryption: async () => ({ mode: 'plain' }),
        getCurrentClaudeSessionId: () => claudeSessionId,
      },
    });
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[workflow-replay-integration]',
      workflowActivitySource: workflowSource,
    });

    scanner = await createSessionScanner({
      sessionId: claudeSessionId,
      transcriptPath: sessionFile,
      workingDirectory: testDir,
      onMessage: (message) => projector.observe(message),
      onRawJsonlValue: (value, observation) => projector.observeRaw(value, observation),
    });
    workflowSource.armStartupReconciliation();

    await waitFor(() => {
      const headline = metadata.sessionWorkflowActivityHeadlineV1 as {
        recentRuns?: Array<{ runId: string; status: string; statusReason?: string }>;
      };
      return headline.recentRuns?.some((run) => (
        run.runId === 'toolu_replayed'
        && run.status === 'stopped'
        && run.statusReason === 'interrupted'
      )) === true;
    });

    workflowSource.dispose();
  });
});
