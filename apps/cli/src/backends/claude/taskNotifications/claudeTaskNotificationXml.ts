export type ClaudeTaskNotificationEnvelope = Readonly<{
  text: string;
  sourceSessionId?: string;
  uuid?: string;
}>;

export type ClaudeTaskNotificationXml = Readonly<{
  taskId: string | null;
  toolUseId: string | null;
  status: string | null;
  summary: string | null;
  result: string | null;
  sourceSessionId?: string;
  uuid?: string;
}>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readTextContent(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  const texts: string[] = [];
  for (const item of value) {
    const text = readString(readRecord(item)?.text);
    if (text) texts.push(text);
  }
  return texts.length > 0 ? texts.join('\n') : null;
}

function readXmlTag(source: string, tag: string): string | null {
  const match = source.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return match?.[1] !== undefined ? readString(match[1]) : null;
}

function isTaskNotificationXml(text: string): boolean {
  return /^\s*<task-notification\b/i.test(text);
}

export function extractClaudeTaskNotificationEnvelope(value: unknown): ClaudeTaskNotificationEnvelope | null {
  const message = readRecord(value);
  if (!message) return null;

  const sourceSessionId = readString(message.session_id) ?? readString(message.sessionId) ?? undefined;
  const uuid = readString(message.uuid) ?? undefined;

  if (message.type === 'queue-operation' && message.operation === 'enqueue') {
    const text = readString(message.content);
    if (text && isTaskNotificationXml(text)) {
      return { text, ...(sourceSessionId ? { sourceSessionId } : {}), ...(uuid ? { uuid } : {}) };
    }
  }

  if (message.type === 'attachment') {
    const attachment = readRecord(message.attachment);
    if (attachment?.type === 'queued_command') {
      const text = readString(attachment.prompt);
      if (text && isTaskNotificationXml(text)) {
        return { text, ...(sourceSessionId ? { sourceSessionId } : {}), ...(uuid ? { uuid } : {}) };
      }
    }
  }

  if (message.type === 'user') {
    const nested = readRecord(message.message);
    const text = readTextContent(nested?.content);
    if (text && isTaskNotificationXml(text)) {
      return { text, ...(sourceSessionId ? { sourceSessionId } : {}), ...(uuid ? { uuid } : {}) };
    }
  }

  return null;
}

export function parseClaudeTaskNotificationXml(value: unknown): ClaudeTaskNotificationXml | null {
  const envelope = typeof value === 'string'
    ? (isTaskNotificationXml(value) ? { text: value } : null)
    : extractClaudeTaskNotificationEnvelope(value);
  if (!envelope) return null;

  return {
    taskId: readXmlTag(envelope.text, 'task-id'),
    toolUseId: readXmlTag(envelope.text, 'tool-use-id'),
    status: readXmlTag(envelope.text, 'status'),
    summary: readXmlTag(envelope.text, 'summary'),
    result: readXmlTag(envelope.text, 'result'),
    ...(envelope.sourceSessionId ? { sourceSessionId: envelope.sourceSessionId } : {}),
    ...(envelope.uuid ? { uuid: envelope.uuid } : {}),
  };
}
