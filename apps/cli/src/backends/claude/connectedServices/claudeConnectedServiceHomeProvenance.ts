import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ConnectedServiceCredentialRevisionV1Schema,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceCredentialRevisionV1,
} from '@happier-dev/protocol';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import {
  buildClaudeCodeCredentialPayload,
  computeClaudeCodeCredentialFingerprint,
} from './nativeAuth/claudeCodeCredentialFile';

export const CLAUDE_CONNECTED_SERVICE_HOME_PROVENANCE_FILE_NAME =
  '.happier-claude-connected-service-home.json';

type ClaudeConnectedServiceHomeSelectionProvenance =
  | Readonly<{
      kind: 'profile';
      profileId: string;
    }>
  | Readonly<{
      kind: 'group';
      groupId: string;
      activeProfileId: string;
      fallbackProfileId: string;
    }>;

export type ClaudeConnectedServiceHomeSelectionDescriptor =
  | Readonly<{
      kind: 'profile';
      serviceId: 'claude-subscription';
      profileId: string;
    }>
  | Readonly<{
      kind: 'group';
      serviceId: 'claude-subscription';
      groupId: string;
      activeProfileId: string;
      fallbackProfileId: string;
      generation: number;
      credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
    }>;

export type ClaudeConnectedServiceHomeProvenanceV1 = Readonly<{
  v: 1;
  serviceId: 'claude-subscription';
  credentialProfileId: string;
  credentialCreatedAt: number;
  credentialFingerprint?: string | undefined;
  credentialRevision?: ConnectedServiceCredentialRevisionV1 | undefined;
  generation?: number | undefined;
  selection: ClaudeConnectedServiceHomeSelectionProvenance;
}>;

export function isClaudeConnectedServiceHomeGenerationSuperseded(input: Readonly<{
  incomingSelection: ClaudeConnectedServiceHomeSelectionDescriptor;
  existingProvenance: ClaudeConnectedServiceHomeProvenanceV1 | null;
}>): boolean {
  if (input.incomingSelection.kind !== 'group') return false;
  const existing = input.existingProvenance;
  return existing?.selection.kind === 'group'
    && existing.selection.groupId === input.incomingSelection.groupId
    && typeof existing.generation === 'number'
    && existing.generation > input.incomingSelection.generation;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readCredentialFingerprint(value: unknown): string | undefined {
  const text = readNonBlankString(value);
  return text?.match(/^sha256:[a-f0-9]{64}$/) ? text : undefined;
}

function buildCredentialFingerprint(record: ConnectedServiceCredentialRecordV1): string | undefined {
  const built = buildClaudeCodeCredentialPayload(record);
  return built.status === 'ok'
    ? computeClaudeCodeCredentialFingerprint(built.payload)
    : undefined;
}

export function resolveClaudeConnectedServiceHomeProvenancePath(claudeConfigDir: string): string {
  return join(claudeConfigDir, CLAUDE_CONNECTED_SERVICE_HOME_PROVENANCE_FILE_NAME);
}

export function buildClaudeConnectedServiceHomeProvenance(params: Readonly<{
  record: ConnectedServiceCredentialRecordV1;
  selectionDescriptor: ClaudeConnectedServiceHomeSelectionDescriptor;
  credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
}>): ClaudeConnectedServiceHomeProvenanceV1 {
  const credentialFingerprint = buildCredentialFingerprint(params.record);
  if (params.selectionDescriptor.kind === 'group') {
    return {
      v: 1,
      serviceId: 'claude-subscription',
      credentialProfileId: params.record.profileId,
      credentialCreatedAt: params.record.createdAt,
      ...(credentialFingerprint ? { credentialFingerprint } : {}),
      ...(params.credentialRevision ?? params.selectionDescriptor.credentialRevision
        ? { credentialRevision: params.credentialRevision ?? params.selectionDescriptor.credentialRevision ?? undefined }
        : {}),
      generation: params.selectionDescriptor.generation,
      selection: {
        kind: 'group',
        groupId: params.selectionDescriptor.groupId,
        activeProfileId: params.selectionDescriptor.activeProfileId,
        fallbackProfileId: params.selectionDescriptor.fallbackProfileId,
      },
    };
  }
  return {
    v: 1,
    serviceId: 'claude-subscription',
    credentialProfileId: params.record.profileId,
    credentialCreatedAt: params.record.createdAt,
    ...(credentialFingerprint ? { credentialFingerprint } : {}),
    selection: {
      kind: 'profile',
      profileId: params.selectionDescriptor.profileId,
    },
  };
}

export function parseClaudeConnectedServiceHomeProvenance(
  value: unknown,
): ClaudeConnectedServiceHomeProvenanceV1 | null {
  const root = readObject(value);
  if (!root || root.v !== 1 || root.serviceId !== 'claude-subscription') return null;
  const credentialProfileId = readNonBlankString(root.credentialProfileId);
  const credentialCreatedAt = readFiniteNumber(root.credentialCreatedAt);
  const credentialFingerprint = readCredentialFingerprint(root.credentialFingerprint);
  const credentialRevision = ConnectedServiceCredentialRevisionV1Schema.safeParse(root.credentialRevision);
  const generation = readFiniteNumber(root.generation);
  const selection = readObject(root.selection);
  if (!credentialProfileId || credentialCreatedAt === null || !selection) return null;
  if (selection.kind === 'profile') {
    const profileId = readNonBlankString(selection.profileId);
    if (!profileId) return null;
    return {
      v: 1,
      serviceId: 'claude-subscription',
      credentialProfileId,
      credentialCreatedAt,
      ...(credentialFingerprint ? { credentialFingerprint } : {}),
      ...(credentialRevision.success ? { credentialRevision: credentialRevision.data } : {}),
      ...(generation !== null ? { generation: Math.trunc(generation) } : {}),
      selection: {
        kind: 'profile',
        profileId,
      },
    };
  }
  if (selection.kind === 'group') {
    const groupId = readNonBlankString(selection.groupId);
    const activeProfileId = readNonBlankString(selection.activeProfileId);
    const fallbackProfileId = readNonBlankString(selection.fallbackProfileId);
    if (!groupId || !activeProfileId || !fallbackProfileId) return null;
    return {
      v: 1,
      serviceId: 'claude-subscription',
      credentialProfileId,
      credentialCreatedAt,
      ...(credentialFingerprint ? { credentialFingerprint } : {}),
      ...(credentialRevision.success ? { credentialRevision: credentialRevision.data } : {}),
      ...(generation !== null ? { generation: Math.trunc(generation) } : {}),
      selection: {
        kind: 'group',
        groupId,
        activeProfileId,
        fallbackProfileId,
      },
    };
  }
  return null;
}

export async function readClaudeConnectedServiceHomeProvenance(
  claudeConfigDir: string,
): Promise<ClaudeConnectedServiceHomeProvenanceV1 | null> {
  try {
    return parseClaudeConnectedServiceHomeProvenance(
      JSON.parse(await readFile(resolveClaudeConnectedServiceHomeProvenancePath(claudeConfigDir), 'utf8')),
    );
  } catch {
    return null;
  }
}

export function matchesClaudeConnectedServiceHomeProvenance(
  expected: ClaudeConnectedServiceHomeProvenanceV1,
  actual: ClaudeConnectedServiceHomeProvenanceV1 | null | undefined,
): boolean {
  if (!actual) return false;
  if (
    actual.v !== expected.v
    || actual.serviceId !== expected.serviceId
    || actual.credentialProfileId !== expected.credentialProfileId
    || actual.credentialCreatedAt !== expected.credentialCreatedAt
    || (
      expected.credentialFingerprint !== undefined
      && actual.credentialFingerprint !== expected.credentialFingerprint
    )
    || (
      expected.credentialRevision !== undefined
      && actual.credentialRevision !== expected.credentialRevision
    )
    || (expected.generation !== undefined && actual.generation !== expected.generation)
    || actual.selection.kind !== expected.selection.kind
  ) {
    return false;
  }
  if (expected.selection.kind === 'profile') {
    return actual.selection.kind === 'profile'
      && actual.selection.profileId === expected.selection.profileId;
  }
  return actual.selection.kind === 'group'
    && actual.selection.groupId === expected.selection.groupId
    && actual.selection.activeProfileId === expected.selection.activeProfileId
    && actual.selection.fallbackProfileId === expected.selection.fallbackProfileId;
}

/**
 * Withdraw a home's provenance record before its credentials or `.claude.json` identity change.
 * The record is published again only after both succeed, so a rewrite that fails part-way leaves
 * no record that could vouch for the new bytes under the old tuple; readers then see unproven.
 * An already-absent record is fine; any other failure aborts the rewrite before it mutates.
 */
export async function withdrawClaudeConnectedServiceHomeProvenance(claudeConfigDir: string): Promise<void> {
  await unlink(resolveClaudeConnectedServiceHomeProvenancePath(claudeConfigDir)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
  });
}

export async function writeClaudeConnectedServiceHomeProvenance(params: Readonly<{
  claudeConfigDir: string;
  provenance: ClaudeConnectedServiceHomeProvenanceV1;
}>): Promise<void> {
  await writeJsonAtomic(
    resolveClaudeConnectedServiceHomeProvenancePath(params.claudeConfigDir),
    params.provenance,
  );
}
