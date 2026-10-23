/** A runner reports `PID-<pid>` before the server has created its session; it names no server session. */
export function isPidPlaceholderSessionId(value: string): boolean {
  return /^PID-\d+$/.test(value);
}
