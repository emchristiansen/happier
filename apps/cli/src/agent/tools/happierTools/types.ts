export type HappierBuiltInToolDefinition = Readonly<{
  name: string;
  title: string;
  description: string;
  inputSchema: unknown;
  annotations?: Readonly<{
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  }>;
}>;

export type HappierBuiltInToolDispatchResult =
  | Readonly<{ ok: true; result: unknown }>
  | Readonly<{ ok: false; errorCode: string; error: string; candidates?: string[]; details?: unknown }>;
