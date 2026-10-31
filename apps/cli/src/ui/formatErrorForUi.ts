import { redactBugReportSensitiveText } from '@happier-dev/protocol';

/**
 * Convert an unknown thrown value into a user-visible string.
 *
 * Intended for UI surfaces (TUI/mobile) where giant stacks can be noisy; we keep a generous cap.
 */
export function formatErrorForUi(error: unknown, opts?: { maxChars?: number }): string {
  const maxChars = Math.max(1000, opts?.maxChars ?? 50_000);

  const msg = (() => {
    if (error instanceof Error && !(error instanceof AggregateError) && error.cause === undefined) {
      return error.stack || error.message || String(error);
    }

    if (typeof error === 'object' && error !== null) {
      const ancestors: { value: object; serialized: object }[] = [];
      try {
        return JSON.stringify(
          error,
          function (this: unknown, _key: string, value: unknown) {
            // JSON visits children through the projected Error object, while cycles
            // refer to the original Error. Keep both identities on the current path.
            while (ancestors.length && ancestors[ancestors.length - 1].serialized !== this) {
              ancestors.pop();
            }
            if (typeof value === 'object' && value !== null) {
              if (ancestors.some((ancestor) => ancestor.value === value)) return '[Circular]';
              const serialized = value instanceof Error ? {
                name: value.name,
                message: value.message,
                stack: value.stack,
                ...(value instanceof AggregateError ? { errors: value.errors } : {}),
                cause: value.cause,
              } : value;
              ancestors.push({ value, serialized });
              return serialized;
            }
            if (typeof value === 'bigint') return value.toString();
            return value;
          },
          2,
        );
      } catch {
        return String(error);
      }
    }

    return String(error);
  })();

  const redacted = redactBugReportSensitiveText(msg);
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}\n…[truncated]` : redacted;
}
