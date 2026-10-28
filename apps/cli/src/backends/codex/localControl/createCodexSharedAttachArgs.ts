export type CodexSharedAttachTarget = Readonly<{
  endpoint: string;
  directory: string;
  sessionId: string;
}>;

export function createCodexSharedAttachArgs(target: CodexSharedAttachTarget): string[] {
  return [
    '--remote', target.endpoint,
    '--cd', target.directory,
    'resume', target.sessionId,
  ];
}
