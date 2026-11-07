/** Native transcript evidence shared by consuming launcher tests. */
export function completedNativeChildTranscript(sessionId = 'claude-session-1'): unknown[] {
  return ['a', 'b'].flatMap((id) => [
    {
      type: 'assistant', session_id: sessionId,
      message: { content: [{ type: 'tool_use', id, name: 'Task', input: { description: id, subagent_type: 'general-purpose' } }] },
    },
    {
      type: 'user', session_id: sessionId,
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'launched' }] },
      toolUseResult: { status: 'async_launched', agentId: `native-${id}` },
    },
    { type: 'attachment', session_id: sessionId, attachment: { type: 'task_status', taskId: `native-${id}`, status: 'completed' } },
  ]);
}
